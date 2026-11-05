import { describe, expect, it } from "vitest";
import { checkoutFailurePushPayload, declineReason } from "./checkout-failure-messages.ts";

const base = {
  id: "f1",
  workspace_id: "w1",
  amount_cents: 0,
  currency: "BRL",
  product_name: "Drinfy Anual",
  reason_code: null,
  campaign_name: "Festa",
  ad_name: "Vídeo 3",
  utm_content: null,
};

describe("push de checkout com falha", () => {
  it("cartão recusado traz o motivo em português e a origem", () => {
    expect(checkoutFailurePushPayload({ ...base, kind: "declined", reason_code: "insufficient_funds" })).toEqual({
      title: "💳 Pagamento recusado",
      body: "Drinfy Anual · Saldo insuficiente e não tentou de novo\nFesta › Vídeo 3",
      url: "/w/w1/vendas",
      tag: "checkout_failure:f1",
    });
  });

  it("checkout abandonado com valor e anúncio ainda não sincronizado", () => {
    const payload = checkoutFailurePushPayload({
      ...base,
      kind: "expired",
      amount_cents: 19700,
      campaign_name: null,
      ad_name: null,
      utm_content: "Vídeo novo|120222",
    });
    expect(payload.title).toBe("🛒 Checkout abandonado · R$ 197,00");
    expect(payload.body).toBe("Drinfy Anual · Abriu o checkout e não concluiu\nVídeo novo (anúncio ainda não sincronizado)");
  });

  it("cobrança recusada no fim do teste", () => {
    const payload = checkoutFailurePushPayload({ ...base, kind: "renewal_failed", amount_cents: 6700, reason_code: "expired_card" });
    expect(payload.title).toBe("⚠️ Cobrança recusada · R$ 67,00");
    expect(payload.body).toContain("Fim do teste ou renovação: cartão vencido");
  });

  it("motivo desconhecido aparece legível", () => {
    expect(declineReason("some_new_code")).toBe("some new code");
    expect(declineReason(null)).toBeNull();
  });
});
