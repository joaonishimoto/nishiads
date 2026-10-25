import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode, encryptPayload, vapidAuthorization } from "./webpush.ts";

// RFC 8291, seção 5 (exemplo completo de criptografia).
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("Web Push (RFC 8291)", () => {
  it("reproduz o vetor de teste da RFC", async () => {
    const body = await encryptPayload(
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      new TextEncoder().encode(RFC.plaintext),
      {
        salt: base64UrlDecode(RFC.salt),
        senderKeys: { publicKey: base64UrlDecode(RFC.asPublic), privateKey: base64UrlDecode(RFC.asPrivate) },
      },
    );
    expect(base64UrlEncode(body)).toBe(RFC.body);
  });

  it("gera um JWT VAPID ES256 verificável com a chave pública", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const vapid = { publicKey: base64UrlEncode(publicRaw), privateKey: jwk.d!, subject: "mailto:teste@nishiads.com" };

    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", vapid, 1_800_000_000_000);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, c, s, k] = match!;
    expect(k).toBe(vapid.publicKey);
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(c!)));
    expect(claims).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_800_000_000 + 43_200, sub: vapid.subject });

    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      base64UrlDecode(s!),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(valid).toBe(true);
  });
});
