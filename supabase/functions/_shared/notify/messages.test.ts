import { describe, expect, it } from "vitest";
import { saleNotificationKind, salePushPayload } from "./messages.ts";

const sale = {
  id: "s1",
  workspace_id: "w1",
  gross_amount_cents: 19700,
  currency: "BRL",
  product_name: "Curso de Tráfego",
  campaign_name: "Black Friday",
  ad_name: "Vídeo depoimento",
};

describe("mensagens de push", () => {
  it("monta a venda aprovada com valor, produto e origem", () => {
    expect(salePushPayload("sale_approved", sale)).toEqual({
      title: "💰 Venda aprovada · R$ 197,00",
      body: "Curso de Tráfego\nBlack Friday › Vídeo depoimento",
      url: "/w/w1/vendas/s1",
      tag: "sale_approved:s1",
    });
  });

  it("indica quando a venda não tem origem", () => {
    const payload = salePushPayload("sale_refunded", { ...sale, campaign_name: null, ad_name: null, product_name: null });
    expect(payload.title).toBe("↩️ Reembolso · R$ 197,00");
    expect(payload.body).toBe("Sem origem identificada");
  });

  it("só notifica aprovada, reembolso e chargeback", () => {
    expect(saleNotificationKind("approved")).toBe("sale_approved");
    expect(saleNotificationKind("chargeback")).toBe("sale_chargeback");
    expect(saleNotificationKind("pending")).toBeNull();
    expect(saleNotificationKind("canceled")).toBeNull();
  });
});
