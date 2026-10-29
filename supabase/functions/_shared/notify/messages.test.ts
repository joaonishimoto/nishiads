import { describe, expect, it } from "vitest";
import { registrationsPushPayload, saleNotificationKind, salePushPayload } from "./messages.ts";

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

  it("monta o teste iniciado sem valor", () => {
    const payload = salePushPayload("trial_started", { ...sale, gross_amount_cents: 0 });
    expect(payload.title).toBe("🧪 Teste iniciado");
    expect(payload.body).toBe("Curso de Tráfego\nBlack Friday › Vídeo depoimento");
  });

  it("agrupa cadastros por anúncio, do maior para o menor", () => {
    const payload = registrationsPushPayload(
      "w1",
      [
        { campaign_name: "Topo", ad_name: "Reels A", count: 1 },
        { campaign_name: "Topo", ad_name: "Reels B", count: 2 },
      ],
      "t",
    );
    expect(payload.title).toBe("📝 3 novos cadastros");
    expect(payload.body).toBe("2× Topo › Reels B\n1× Topo › Reels A");
    expect(registrationsPushPayload("w1", [{ campaign_name: "Topo", ad_name: "Reels A", count: 1 }], "t")).toMatchObject({
      title: "📝 Novo cadastro",
      body: "Topo › Reels A",
    });
  });

  it("só notifica aprovada, reembolso, chargeback e teste", () => {
    expect(saleNotificationKind("approved")).toBe("sale_approved");
    expect(saleNotificationKind("chargeback")).toBe("sale_chargeback");
    expect(saleNotificationKind("trialing")).toBe("trial_started");
    expect(saleNotificationKind("pending")).toBeNull();
    expect(saleNotificationKind("canceled")).toBeNull();
  });
});
