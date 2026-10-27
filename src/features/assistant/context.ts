/**
 * O recorte que o assistente de IA recebe: os mesmos números da tela de Campanhas (período,
 * totais, série diária e a árvore Campanha › Conjunto › Anúncio), em JSON compacto e com
 * nomes de campo em português para o modelo ler sem tradução.
 */
import {
  derived,
  type Budget,
  type DailyPoint,
  type NodeMetrics,
  type ProductCost,
  type Totals,
  type TreeNode,
} from "@/features/results/metrics";

/** Teto de linhas por nível: o resto entra só na contagem de "omitidos". */
export const CONTEXT_LIMITS = { campaigns: 40, adsets: 25, ads: 25 } as const;

const money = (cents: number) => Math.round(cents) / 100;
const ratio = (n: number | null, digits = 2) =>
  n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits;
const pct = (n: number | null) => (n === null ? null : Math.round(n * 10_000) / 100);

function budget(b: Budget | null) {
  return b ? { tipo: b.kind === "daily" ? "diario" : "total", valor: money(b.cents) } : null;
}

function metrics(m: NodeMetrics) {
  return {
    gasto: money(m.spendCents),
    impressoes: m.impressions,
    cliques_link: m.linkClicks,
    ctr_pct: pct(derived.ctr(m)),
    cpc: derived.cpc(m) === null ? null : money(derived.cpc(m)!),
    vendas: m.sales,
    receita: money(m.revenueCents),
    roas: ratio(derived.roas(m)),
    cpa: derived.cpa(m) === null ? null : money(derived.cpa(m)!),
    lucro: money(derived.profit(m)),
  };
}

function totals(t: Totals) {
  return {
    gasto: money(t.spendCents),
    receita: money(t.revenueCents),
    vendas_aprovadas: t.approvedCount,
    lucro: money(t.profitCents),
    roas: ratio(t.roas),
    cpa: t.cpaCents === null ? null : money(t.cpaCents),
    ticket_medio: t.ticketCents === null ? null : money(t.ticketCents),
    taxas: money(t.feesCents),
    custo_produtos: money(t.costCents),
    impressoes: t.impressions,
    cliques_link: t.linkClicks,
    vendas_atribuidas_pct: pct(t.matchedShare),
    vendas_sem_origem: t.unmatchedApprovedCount,
    receita_sem_origem: money(t.unmatchedRevenueCents),
    reembolsos: t.refundCount,
    valor_reembolsado: money(t.refundCents),
    pendentes: t.pendingCount,
    valor_pendente: money(t.pendingCents),
    testes_gratis: t.trialCount,
    testes_convertidos: t.trialConvertedCount,
  };
}

/** Maior gasto primeiro; empate decide pela receita. */
function bySpend(a: TreeNode, b: TreeNode): number {
  return (
    b.metrics.spendCents - a.metrics.spendCents || b.metrics.revenueCents - a.metrics.revenueCents
  );
}

export type AssistantContextInput = {
  currency: string;
  timezone: string;
  period: { label: string; first: string; last: string; comparison: string };
  account: string | null;
  product: string | null;
  lastSync: string | null;
  roasTarget: number;
  totals: Totals;
  previous: Totals | null;
  series: DailyPoint[];
  tree: TreeNode[];
  products: ProductCost[];
};

export type AssistantContext = ReturnType<typeof buildAssistantContext>;

export function buildAssistantContext(input: AssistantContextInput) {
  const omitted = { campanhas: 0, conjuntos: 0, anuncios: 0 };
  const take = (nodes: TreeNode[], limit: number, key: keyof typeof omitted) => {
    const sorted = [...nodes].sort(bySpend);
    omitted[key] += Math.max(0, sorted.length - limit);
    return sorted.slice(0, limit);
  };
  const node = (n: TreeNode) => ({
    id: n.id,
    nome: n.name,
    status: n.status,
    status_configurado: n.configuredStatus,
    ...metrics(n.metrics),
  });

  const campanhas = take(input.tree, CONTEXT_LIMITS.campaigns, "campanhas").map((c) => ({
    ...node(c),
    orcamento: budget(c.budget),
    conjuntos: take(c.children, CONTEXT_LIMITS.adsets, "conjuntos").map((s) => ({
      ...node(s),
      orcamento: budget(s.budget),
      usa_orcamento_da_campanha: s.usesCampaignBudget,
      anuncios: take(s.children, CONTEXT_LIMITS.ads, "anuncios").map(node),
    })),
  }));

  return {
    moeda: input.currency,
    fuso_horario: input.timezone,
    periodo: {
      rotulo: input.period.label,
      de: input.period.first,
      ate: input.period.last,
      comparacao: input.period.comparison,
    },
    filtros: { conta_de_anuncio: input.account, produto: input.product },
    meta_sincronizada_em: input.lastSync,
    meta_roas: input.roasTarget,
    totais: totals(input.totals),
    periodo_anterior: input.previous ? totals(input.previous) : null,
    serie: input.series.map((p) => ({
      dia: p.key,
      gasto: money(p.spendCents),
      receita: money(p.revenueCents),
      vendas: p.sales,
    })),
    produtos: input.products.map((p) => ({
      nome: p.name,
      custo: money(p.cost_cents),
      taxa_pct: p.fee_percent_bps / 100,
      taxa_fixa: money(p.fee_fixed_cents),
    })),
    campanhas,
    omitidos_por_limite: omitted,
  };
}

/** Acha o objeto na árvore atual e os pais dele (o diálogo de pausa usa os pais). */
type Found = { node: TreeNode; ancestors: TreeNode[] };

export function findInTree(tree: TreeNode[], id: string, ancestors: TreeNode[] = []): Found | null {
  for (const n of tree) {
    if (n.id === id) return { node: n, ancestors };
    const found = findInTree(n.children, id, [...ancestors, n]);
    if (found) return found;
  }
  return null;
}
