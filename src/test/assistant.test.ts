import { describe, expect, it } from "vitest";
import { computeTotals, type NodeMetrics, type TreeNode } from "@/features/results/metrics";
import { buildAssistantContext, CONTEXT_LIMITS, findInTree } from "@/features/assistant/context";
import { collapse, toApiMessages, type ChatMessage } from "@/features/assistant/api";

const metrics = (over: Partial<NodeMetrics> = {}): NodeMetrics => ({
  spendCents: 0,
  impressions: 0,
  linkClicks: 0,
  sales: 0,
  revenueCents: 0,
  feesCents: 0,
  costCents: 0,
  ...over,
});

const node = (id: string, level: TreeNode["level"], over: Partial<TreeNode> = {}): TreeNode => ({
  id,
  level,
  name: id,
  accountId: "acc",
  status: "ACTIVE",
  configuredStatus: "ACTIVE",
  budget: null,
  usesCampaignBudget: false,
  thumbnailUrl: null,
  previewLink: null,
  metrics: metrics(),
  children: [],
  ...over,
});

const ad = node("ad1", "ad", {
  metrics: metrics({
    spendCents: 30_000,
    impressions: 10_000,
    linkClicks: 200,
    sales: 2,
    revenueCents: 90_000,
    feesCents: 9_000,
  }),
});
const adset = node("set1", "adset", { usesCampaignBudget: true, children: [ad] });
const campaign = node("camp1", "campaign", {
  budget: { kind: "daily", cents: 10_000 },
  children: [adset],
  metrics: ad.metrics,
});

const input = (tree: TreeNode[]) => ({
  currency: "BRL",
  timezone: "America/Sao_Paulo",
  period: {
    label: "Últimos 7 dias",
    first: "2026-10-20",
    last: "2026-10-26",
    comparison: "vs. 7 dias antes",
  },
  account: null,
  product: null,
  lastSync: null,
  roasTarget: 2,
  totals: computeTotals([], [], new Map(), "BRL"),
  previous: null,
  series: [{ key: "2026-10-20", label: "seg", spendCents: 1_050, revenueCents: 0, sales: 0 }],
  tree,
  products: [],
});

describe("buildAssistantContext", () => {
  it("leva métricas em reais, orçamento e a árvore com ids", () => {
    const ctx = buildAssistantContext(input([campaign]));
    const c = ctx.campanhas[0]!;
    expect(c).toMatchObject({
      id: "camp1",
      orcamento: { tipo: "diario", valor: 100 },
      gasto: 300,
      receita: 900,
      vendas: 2,
      roas: 3,
      cpa: 150,
      cpc: 1.5,
      ctr_pct: 2,
      lucro: 510,
    });
    expect(c.conjuntos[0]).toMatchObject({ id: "set1", usa_orcamento_da_campanha: true });
    expect(c.conjuntos[0]!.anuncios[0]!.id).toBe("ad1");
    expect(ctx.serie[0]).toEqual({ dia: "2026-10-20", gasto: 10.5, receita: 0, vendas: 0 });
  });

  it("corta pelos maiores gastos e conta o que ficou de fora", () => {
    const many = Array.from({ length: CONTEXT_LIMITS.campaigns + 3 }, (_, i) =>
      node(`c${i}`, "campaign", { metrics: metrics({ spendCents: i * 100 }) }),
    );
    const ctx = buildAssistantContext(input(many));
    expect(ctx.campanhas).toHaveLength(CONTEXT_LIMITS.campaigns);
    expect(ctx.campanhas[0]!.id).toBe(`c${CONTEXT_LIMITS.campaigns + 2}`);
    expect(ctx.omitidos_por_limite.campanhas).toBe(3);
  });
});

describe("findInTree", () => {
  it("acha o anúncio com os pais", () => {
    const found = findInTree([campaign], "ad1");
    expect(found?.node.id).toBe("ad1");
    expect(found?.ancestors.map((a) => a.id)).toEqual(["camp1", "set1"]);
    expect(findInTree([campaign], "nada")).toBeNull();
  });
});

describe("histórico para a API", () => {
  const msg = (role: ChatMessage["role"], content: string, over: Partial<ChatMessage> = {}) =>
    ({ id: content, role, content, proposals: [], ...over }) as ChatMessage;

  it("junta perguntas seguidas e registra as sugestões por escrito", () => {
    const out = toApiMessages([
      msg("user", "a"),
      msg("assistant", "b", {
        proposals: [
          {
            level: "ad",
            id: "ad1",
            name: "Vídeo 1",
            action: "pause",
            budget_cents: null,
            budget_kind: null,
            reason: "r",
          },
        ],
      }),
      msg("user", "c"),
      msg("user", "d"),
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[1]!.content).toContain("pausar “Vídeo 1”");
    expect(out[2]!.content).toBe("c\n\nd");
  });

  it("corta o começo sem deixar o assistente em primeiro", () => {
    const long = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user", `m${i}`));
    const out = toApiMessages([...long, msg("user", "fim")], 4);
    expect(out[0]!.role).toBe("user");
    expect(out.at(-1)!.content).toBe("fim");
    expect(collapse([]).length).toBe(0);
  });
});
