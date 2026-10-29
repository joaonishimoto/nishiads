import { describe, expect, it } from "vitest";
import {
  buildTree,
  change,
  computeTotals,
  dailySeries,
  diagnoseUnmatched,
  filterSales,
  saleDeductions,
  type AdStructure,
  type InsightRow,
  type ProductCost,
  type ResultSale,
} from "@/features/results/metrics";
import { daySpan, periodDays, previousDays } from "@/lib/period";

const sale = (over: Partial<ResultSale>): ResultSale => ({
  id: Math.random().toString(36).slice(2),
  provider: "kiwify",
  external_order_id: "x",
  status: "approved",
  gross_amount_cents: 10_000,
  net_amount_cents: null,
  currency: "BRL",
  product_id: null,
  product_name: "Curso",
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_content: null,
  utm_term: null,
  attribution_status: "unattributed",
  campaign_id: null,
  adset_id: null,
  ad_id: null,
  paid_at: "2026-10-20T15:00:00Z",
  created_at: "2026-10-20T15:00:00Z",
  trial_converted_at: null,
  campaign: null,
  adset: null,
  ad: null,
  ...over,
});

const structure: AdStructure = {
  campaigns: [
    { id: "c1", name: "Campanha 1", ad_account_id: "acc1", effective_status: "ACTIVE" },
    { id: "c2", name: "Campanha 2", ad_account_id: "acc1", effective_status: "PAUSED" },
  ],
  adsets: [
    {
      id: "s1",
      name: "Conjunto 1",
      ad_account_id: "acc1",
      campaign_id: "c1",
      effective_status: "ACTIVE",
    },
  ],
  ads: [
    {
      id: "a1",
      name: "Anúncio 1",
      ad_account_id: "acc1",
      campaign_id: "c1",
      adset_id: "s1",
      effective_status: "ACTIVE",
      thumbnail_url: null,
      preview_link: null,
    },
  ],
};

const insight = (over: Partial<InsightRow>): InsightRow => ({
  ad_id: "a1",
  date: "2026-10-20",
  ad_account_id: "acc1",
  currency: "BRL",
  spend_cents: 5_000,
  impressions: 1000,
  clicks: 30,
  link_clicks: 20,
  registrations: 0,
  trials: 0,
  ...over,
});

describe("métricas de resultado", () => {
  it("taxas do produto valem mais que o líquido do checkout", () => {
    const product: ProductCost = {
      id: "p",
      name: "P",
      cost_cents: 1_000,
      fee_percent_bps: 990,
      fee_fixed_cents: 100,
    };
    expect(
      saleDeductions({ gross_amount_cents: 10_000, net_amount_cents: 9_000 }, product),
    ).toEqual({ fees: 1_090, cost: 1_000 });
    expect(
      saleDeductions({ gross_amount_cents: 10_000, net_amount_cents: 9_000 }, undefined),
    ).toEqual({ fees: 1_000, cost: 0 });
    expect(
      saleDeductions({ gross_amount_cents: 10_000, net_amount_cents: null }, undefined),
    ).toEqual({ fees: 0, cost: 0 });
  });

  it("calcula faturamento, ROAS, CPA e lucro sem misturar moedas", () => {
    const sales = [
      sale({ attribution_status: "matched", campaign_id: "c1" }),
      sale({ gross_amount_cents: 20_000, net_amount_cents: 18_000 }),
      sale({ currency: "USD", gross_amount_cents: 99_999 }),
      sale({ status: "refunded" }),
      sale({
        status: "trialing",
        gross_amount_cents: 0,
        trial_converted_at: "2026-10-21T00:00:00Z",
      }),
    ];
    const t = computeTotals(
      sales,
      [insight({}), insight({ currency: "USD", spend_cents: 777 })],
      new Map(),
      "BRL",
    );
    expect(t.revenueCents).toBe(30_000);
    expect(t.approvedCount).toBe(3);
    expect(t.spendCents).toBe(5_000);
    expect(t.roas).toBe(6);
    expect(t.cpaCents).toBe(1_667);
    expect(t.profitCents).toBe(30_000 - 2_000 - 5_000);
    expect(t.matchedShare).toBeCloseTo(1 / 3);
    expect(t.refundCount).toBe(1);
    expect(t.trialCount).toBe(1);
    expect(t.trialConvertedCount).toBe(1);
    expect(t.otherCurrencySpend).toBe(true);
  });

  it("monta a árvore com gasto subindo e vendas no nível atribuído", () => {
    const sales = [
      sale({ attribution_status: "matched", campaign_id: "c1", adset_id: "s1", ad_id: "a1" }),
      sale({ attribution_status: "partial", campaign_id: "c1" }),
    ];
    const tree = buildTree(
      structure,
      sales,
      [insight({ registrations: 3, trials: 1 }), insight({ date: "2026-10-21", registrations: 2 })],
      new Map(),
      "BRL",
      null,
    );
    expect(tree).toHaveLength(1); // c2 pausada e sem gasto some
    const c1 = tree[0]!;
    expect(c1.metrics.spendCents).toBe(10_000);
    expect(c1.metrics.sales).toBe(2);
    expect(c1.children[0]!.metrics.sales).toBe(1);
    expect(c1.children[0]!.children[0]!.metrics.spendCents).toBe(10_000);
    // Cadastros e testes da Meta sobem do anúncio como o gasto.
    expect(c1.metrics.registrations).toBe(5);
    expect(c1.children[0]!.children[0]!.metrics.trials).toBe(1);
    expect(buildTree(structure, sales, [], new Map(), "BRL", "outra")).toHaveLength(0);
  });

  it("filtra por conta pela campanha da venda e por produto", () => {
    const sales = [
      sale({ campaign: { id: "c1", name: "C", ad_account_id: "acc1" }, product_id: "p1" }),
      sale({ product_id: "p2" }),
    ];
    expect(filterSales(sales, { accountId: "acc1", productId: null })).toHaveLength(1);
    expect(filterSales(sales, { accountId: null, productId: "p2" })).toHaveLength(1);
  });

  it("série por dia no fuso do workspace e por hora num dia só", () => {
    const sales = [sale({ paid_at: "2026-10-21T02:00:00Z" })]; // 20/10 23h em São Paulo
    const daily = dailySeries(
      sales,
      [insight({})],
      { first: "2026-10-19", last: "2026-10-21" },
      "America/Sao_Paulo",
      "BRL",
    );
    expect(daily.mode).toBe("day");
    expect(daily.points.map((p) => p.revenueCents)).toEqual([0, 10_000, 0]);
    expect(daily.points[1]!.spendCents).toBe(5_000);
    const hourly = dailySeries(
      sales,
      [],
      { first: "2026-10-20", last: "2026-10-20" },
      "America/Sao_Paulo",
      "BRL",
    );
    expect(hourly.points[23]!.revenueCents).toBe(10_000);
  });

  it("diagnostica vendas sem origem", () => {
    const d = diagnoseUnmatched(
      [
        sale({ attribution_status: "partial", utm_content: "Vídeo 3|123456789" }),
        sale({ attribution_status: "partial", utm_content: "Vídeo 3|123456789" }),
        sale({}),
        sale({ attribution_status: "matched" }),
      ],
      "BRL",
    );
    expect(d).toMatchObject({ partial: 2, unattributed: 1, revenueCents: 30_000 });
    expect(d.topUtms[0]).toEqual({ value: "Vídeo 3|123456789", count: 2 });
  });

  it("variação e período anterior", () => {
    expect(change(120, 100)).toBeCloseTo(0.2);
    expect(change(5, 0)).toBeNull();
    const days = periodDays("7d", "America/Sao_Paulo", new Date("2026-10-25T15:00:00Z"));
    expect(days).toEqual({ first: "2026-10-19", last: "2026-10-25" });
    expect(previousDays(days)).toEqual({ first: "2026-10-12", last: "2026-10-18" });
    expect(daySpan("2026-10-01", "2026-10-31")).toBe(31);
  });
});
