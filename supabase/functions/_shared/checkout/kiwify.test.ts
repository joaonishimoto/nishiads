import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { kiwifyAdapter } from "./kiwify.ts";
import { hmacHex, sha256Hex } from "../crypto.ts";
import { parseProviderDate, reaisToCents } from "../values.ts";

const fixture = readFileSync(
  resolve(__dirname, "../../webhooks/fixtures/kiwify-order-approved.json"),
  "utf8",
);

function verify(rawBody: string, signature: string | null, secret: string | null) {
  const url = new URL("https://x.supabase.co/functions/v1/webhooks/kiwify/abc");
  if (signature) url.searchParams.set("signature", signature);
  return kiwifyAdapter.verify({ rawBody, url, headers: new Headers(), secret });
}

describe("Kiwify: assinatura", () => {
  it("bate com o vetor de teste da documentação", async () => {
    const body =
      '{"order_id":"9b1c2d3e-0000-4000-8000-000000000001","order_status":"paid","webhook_event_type":"order_approved"}';
    expect(await hmacHex("SHA-1", "kiwify-token-de-teste", body)).toBe("bf18f352a4f981b91dfa3f6d8742a81080ab8c86");
    expect(await verify(body, "bf18f352a4f981b91dfa3f6d8742a81080ab8c86", "kiwify-token-de-teste")).toEqual({ ok: true });
  });

  it("rejeita assinatura errada, ausente ou integração sem token", async () => {
    expect((await verify(fixture, "0".repeat(40), "segredo-123")).ok).toBe(false);
    expect((await verify(fixture, null, "segredo-123")).ok).toBe(false);
    expect((await verify(fixture, "abc", null)).ok).toBe(false);
  });

  it("assina o corpo bruto, não o JSON re-serializado", async () => {
    const signature = await hmacHex("SHA-1", "segredo-123", fixture);
    expect((await verify(fixture, signature, "segredo-123")).ok).toBe(true);
    expect((await verify(JSON.stringify(JSON.parse(fixture)), signature, "segredo-123")).ok).toBe(false);
  });
});

describe("Kiwify: normalização", () => {
  it("transforma o pedido aprovado no formato de sales", async () => {
    const result = await kiwifyAdapter.normalize(JSON.parse(fixture));
    expect(result.kind).toBe("sale");
    if (result.kind !== "sale") return;
    expect(result.sale).toMatchObject({
      external_order_id: "b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      status: "approved",
      gross_amount_cents: 19700,
      net_amount_cents: 17730,
      currency: "BRL",
      product_name: "Curso Tráfego Pago do Zero",
      utm_source: "FB",
      utm_campaign: "[VENDAS] Black Friday|120200000000000000",
      utm_content: "Vídeo depoimento 01|120222222222222222",
      paid_at: "2026-10-25T22:42:00.000Z",
      refunded_at: null,
    });
    expect(result.sale.customer_email_hash).toBe(await sha256Hex("cliente.teste@exemplo.com"));
  });

  it("mapeia reembolso e chargeback", async () => {
    const base = JSON.parse(fixture);
    const refunded = await kiwifyAdapter.normalize({ ...base, order_status: "refunded", updated_at: "2026-10-26 10:00" });
    const chargeback = await kiwifyAdapter.normalize({ ...base, order_status: "chargedback" });
    expect(refunded.kind === "sale" && refunded.sale.status).toBe("refunded");
    expect(refunded.kind === "sale" && refunded.sale.refunded_at).toBe("2026-10-26T13:00:00.000Z");
    expect(chargeback.kind === "sale" && chargeback.sale.status).toBe("chargeback");
  });

  it("pix gerado vira pendente sem data de pagamento", async () => {
    const result = await kiwifyAdapter.normalize({
      ...JSON.parse(fixture),
      order_status: "waiting_payment",
      webhook_event_type: "pix_created",
      approved_date: null,
    });
    expect(result.kind === "sale" && result.sale.status).toBe("pending");
    expect(result.kind === "sale" && result.sale.paid_at).toBeNull();
  });

  it("ignora carrinho abandonado e eventos só de assinatura", async () => {
    expect((await kiwifyAdapter.normalize({ checkout_link: "x", email: "a@b.com" })).kind).toBe("ignored");
    expect(
      (await kiwifyAdapter.normalize({ ...JSON.parse(fixture), webhook_event_type: "subscription_late" })).kind,
    ).toBe("ignored");
  });

  it("falha com status desconhecido (fica em Logs para reprocessar)", async () => {
    await expect(kiwifyAdapter.normalize({ ...JSON.parse(fixture), order_status: "novo_status" })).rejects.toThrow(
      /desconhecido/,
    );
  });
});

describe("Kiwify: LGPD", () => {
  it("remove dados pessoais e mantém o payload normalizável", async () => {
    const redacted = (await kiwifyAdapter.redact(JSON.parse(fixture))) as Record<string, unknown>;
    const text = JSON.stringify(redacted);
    expect(text).not.toContain("cliente.teste@exemplo.com");
    expect(text).not.toContain("12345678909");
    expect(text).not.toContain("Cliente Teste");
    const result = await kiwifyAdapter.normalize(redacted);
    expect(result.kind === "sale" && result.sale.customer_email_hash).toBe(await sha256Hex("cliente.teste@exemplo.com"));
  });
});

describe("valores", () => {
  it("converte datas e reais", () => {
    expect(parseProviderDate("2026-10-25 19:42")).toBe("2026-10-25T22:42:00.000Z");
    expect(parseProviderDate("2026-10-25T22:42:00Z")).toBe("2026-10-25T22:42:00.000Z");
    expect(parseProviderDate("ontem")).toBeNull();
    expect(reaisToCents("1.234,56")).toBe(123456);
    expect(reaisToCents(197)).toBe(19700);
  });
});
