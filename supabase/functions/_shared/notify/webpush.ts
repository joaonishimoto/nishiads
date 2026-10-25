/**
 * Web Push sem dependências: criptografia do payload (RFC 8291, aes128gcm) e
 * autenticação VAPID (RFC 8292) só com Web Crypto, que existe no Deno e no Node.
 */

const encoder = new TextEncoder();

type Bytes = Uint8Array<ArrayBuffer>;

export interface PushTarget {
  endpoint: string;
  /** Chave pública do navegador (P-256, não comprimida), base64url. */
  p256dh: string;
  /** Segredo de autenticação do navegador (16 bytes), base64url. */
  auth: string;
}

export interface VapidKeys {
  /** Chave pública P-256 não comprimida (65 bytes), base64url. */
  publicKey: string;
  /** Escalar privado (32 bytes), base64url. */
  privateKey: string;
  /** mailto: ou https: de contato, exigido pelos push services. */
  subject: string;
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** 404/410: a inscrição não existe mais e deve ser desativada. */
  gone: boolean;
}

export function base64UrlDecode(value: string): Bytes {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function base64UrlEncode(bytes: Bytes): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** HKDF com uma única rodada de expand (todas as saídas aqui têm até 32 bytes). */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

function p256Jwk(publicKey: Bytes, d?: Bytes): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("Chave pública P-256 inválida.");
  return {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)),
    ...(d ? { d: base64UrlEncode(d) } : {}),
    ext: true,
  };
}

export interface EncryptOptions {
  /** Só para testes com os vetores da RFC; em produção são aleatórios. */
  salt?: Bytes;
  senderKeys?: { publicKey: Bytes; privateKey: Bytes };
}

/** Corpo aes128gcm (cabeçalho + um único registro) para o push service. */
export async function encryptPayload(
  target: Pick<PushTarget, "p256dh" | "auth">,
  plaintext: Bytes,
  options: EncryptOptions = {},
): Promise<Bytes> {
  const uaPublic = base64UrlDecode(target.p256dh);
  const authSecret = base64UrlDecode(target.auth);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));

  let asPublic: Bytes;
  let asPrivate: CryptoKey;
  if (options.senderKeys) {
    asPublic = options.senderKeys.publicKey;
    asPrivate = await crypto.subtle.importKey(
      "jwk",
      p256Jwk(asPublic, options.senderKeys.privateKey),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    asPrivate = pair.privateKey;
  }

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));

  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 = delimitador do último (e único) registro, sem padding.
  const record = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  const recordSize = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/** Cabeçalho Authorization VAPID (JWT ES256) para a origem do endpoint. */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, now = Date.now()): Promise<string> {
  const publicKey = base64UrlDecode(vapid.publicKey);
  const signingKey = await crypto.subtle.importKey(
    "jwk",
    p256Jwk(publicKey, base64UrlDecode(vapid.privateKey)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: vapid.subject,
      }),
    ),
  );
  const unsigned = `${header}.${claims}`;
  // Web Crypto já devolve a assinatura no formato r||s que o JWS usa.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, encoder.encode(unsigned)),
  );
  return `vapid t=${unsigned}.${base64UrlEncode(signature)}, k=${vapid.publicKey}`;
}

export async function sendWebPush(
  target: PushTarget,
  payload: unknown,
  vapid: VapidKeys,
  { ttlSeconds = 24 * 60 * 60, urgency = "high" }: { ttlSeconds?: number; urgency?: "normal" | "high" } = {},
): Promise<PushResult> {
  const body = await encryptPayload(target, encoder.encode(JSON.stringify(payload)));
  const response = await fetch(target.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(target.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSeconds),
      Urgency: urgency,
    },
    body,
  });
  await response.body?.cancel();
  return { ok: response.ok, status: response.status, gone: response.status === 404 || response.status === 410 };
}
