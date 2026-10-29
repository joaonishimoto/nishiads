/**
 * Cálculo das métricas do Dashboard e de Campanhas. Funções puras: recebem as linhas já
 * carregadas (vendas do período, insights diários, estrutura da Meta e produtos) e
 * devolvem totais, série diária e a árvore Campanha › Conjunto › Anúncio.
 */
import { eachDay, ymdInZone } from "@/lib/period";
import { addActions } from "@/features/results/meta-actions";
import type { TrackingEvent } from "@/features/tracking/api";
import type { AttributionStatus, SaleStatus } from "@/types/database";

export type ResultSale = {
  id: string;
  provider: string;
  external_order_id: string;
  status: SaleStatus;
  gross_amount_cents: number;
  net_amount_cents: number | null;
  currency: string;
  product_id: string | null;
  product_name: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  attribution_status: AttributionStatus;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  paid_at: string | null;
  created_at: string;
  trial_converted_at: string | null;
  campaign: { id: string; name: string; ad_account_id: string } | null;
  adset: { id: string; name: string } | null;
  ad: { id: string; name: string; thumbnail_url: string | null } | null;
};

export type InsightRow = {
  ad_id: string;
  date: string;
  ad_account_id: string;
  currency: string;
  spend_cents: number;
  impressions: number;
  clicks: number;
  link_clicks: number;
  /** Cadastros e testes que a Meta atribuiu ao anúncio (pixel/Conversions API). */
  registrations: number;
  trials: number;
  /** Todas as ações da Meta no dia (action_type → quantidade). */
  actions: Record<string, number> | null;
};

export type CampaignEntity = {
  id: string;
  name: string;
  ad_account_id: string;
  effective_status: string | null;
  /** Status que o anunciante escolheu (ACTIVE/PAUSED); a entrega real é o effective_status. */
  status?: string | null;
  daily_budget_cents?: number | null;
  lifetime_budget_cents?: number | null;
};
export type AdsetEntity = CampaignEntity & { campaign_id: string };
export type AdEntity = AdsetEntity & {
  adset_id: string;
  thumbnail_url: string | null;
  preview_link: string | null;
};
export type AdStructure = { campaigns: CampaignEntity[]; adsets: AdsetEntity[]; ads: AdEntity[] };

export type ProductCost = {
  id: string;
  name: string;
  cost_cents: number;
  fee_percent_bps: number;
  fee_fixed_cents: number;
};

export type ResultFilters = { accountId: string | null; productId: string | null };

/** Momento que conta para o período: pagamento quando houver; senão, criação. */
export function saleInstant(sale: Pick<ResultSale, "paid_at" | "created_at">): string {
  return sale.paid_at ?? sale.created_at;
}

export function filterSales(sales: ResultSale[], filters: ResultFilters): ResultSale[] {
  return sales.filter(
    (s) =>
      (!filters.accountId || s.campaign?.ad_account_id === filters.accountId) &&
      (!filters.productId || s.product_id === filters.productId),
  );
}

export function filterInsights(rows: InsightRow[], filters: ResultFilters): InsightRow[] {
  return filters.accountId ? rows.filter((r) => r.ad_account_id === filters.accountId) : rows;
}

/**
 * Taxas e custo de uma venda aprovada. Taxas configuradas no produto valem mais que o
 * líquido informado pelo checkout; sem nenhum dos dois, a taxa é zero.
 */
export function saleDeductions(
  sale: Pick<ResultSale, "gross_amount_cents" | "net_amount_cents">,
  product: ProductCost | undefined,
): { fees: number; cost: number } {
  const cost = product?.cost_cents ?? 0;
  const configured = !!product && (product.fee_percent_bps > 0 || product.fee_fixed_cents > 0);
  const fees = configured
    ? Math.round((sale.gross_amount_cents * product.fee_percent_bps) / 10_000) +
      product.fee_fixed_cents
    : sale.net_amount_cents !== null
      ? Math.max(0, sale.gross_amount_cents - sale.net_amount_cents)
      : 0;
  return { fees, cost };
}

export type Totals = {
  revenueCents: number;
  approvedCount: number;
  spendCents: number;
  impressions: number;
  linkClicks: number;
  /** Cadastros e testes que a Meta atribuiu aos anúncios. */
  registrations: number;
  metaTrials: number;
  allClicks: number;
  actions: Record<string, number>;
  /** Eventos do script de rastreamento por nome (cadastro → quantidade). */
  tracked: Record<string, number>;
  feesCents: number;
  costCents: number;
  profitCents: number;
  roas: number | null;
  cpaCents: number | null;
  ticketCents: number | null;
  matchedShare: number | null;
  matchedRevenueCents: number;
  unmatchedApprovedCount: number;
  unmatchedRevenueCents: number;
  refundCount: number;
  refundCents: number;
  pendingCount: number;
  pendingCents: number;
  trialCount: number;
  trialConvertedCount: number;
  /** Linhas de insights em outra moeda: ficam fora da soma (nunca misturamos moedas). */
  otherCurrencySpend: boolean;
};

export function computeTotals(
  sales: ResultSale[],
  insights: InsightRow[],
  products: Map<string, ProductCost>,
  currency: string,
  events: TrackingEvent[] = [],
): Totals {
  let revenue = 0;
  let approved = 0;
  let fees = 0;
  let cost = 0;
  let matched = 0;
  let matchedRevenue = 0;
  let unmatchedRevenue = 0;
  let refundCount = 0;
  let refundCents = 0;
  let pendingCount = 0;
  let pendingCents = 0;
  let trials = 0;
  let trialsConverted = 0;
  for (const s of sales) {
    const sameCurrency = s.currency === currency;
    switch (s.status) {
      case "approved": {
        approved++;
        if (s.attribution_status === "matched") matched++;
        if (!sameCurrency) break;
        revenue += s.gross_amount_cents;
        if (s.attribution_status === "matched") matchedRevenue += s.gross_amount_cents;
        else unmatchedRevenue += s.gross_amount_cents;
        const d = saleDeductions(s, s.product_id ? products.get(s.product_id) : undefined);
        fees += d.fees;
        cost += d.cost;
        break;
      }
      case "refunded":
      case "chargeback":
        refundCount++;
        if (sameCurrency) refundCents += s.gross_amount_cents;
        break;
      case "pending":
        pendingCount++;
        if (sameCurrency) pendingCents += s.gross_amount_cents;
        break;
      case "trialing":
        trials++;
        if (s.trial_converted_at) trialsConverted++;
        break;
    }
  }
  let spend = 0;
  let impressions = 0;
  let linkClicks = 0;
  let registrations = 0;
  let metaTrials = 0;
  let allClicks = 0;
  const actions: Record<string, number> = {};
  let otherCurrencySpend = false;
  for (const r of insights) {
    if (r.currency !== currency) {
      if (r.spend_cents > 0) otherCurrencySpend = true;
      continue;
    }
    spend += r.spend_cents;
    impressions += r.impressions;
    linkClicks += r.link_clicks;
    registrations += r.registrations;
    metaTrials += r.trials;
    allClicks += r.clicks;
    addActions(actions, r.actions);
  }
  const tracked: Record<string, number> = {};
  for (const e of events) tracked[e.event] = (tracked[e.event] ?? 0) + 1;
  return {
    revenueCents: revenue,
    approvedCount: approved,
    spendCents: spend,
    impressions,
    linkClicks,
    registrations,
    metaTrials,
    allClicks,
    actions,
    tracked,
    feesCents: fees,
    costCents: cost,
    profitCents: revenue - fees - cost - spend,
    roas: spend > 0 ? revenue / spend : null,
    cpaCents: approved > 0 && spend > 0 ? Math.round(spend / approved) : null,
    ticketCents: approved > 0 ? Math.round(revenue / approved) : null,
    matchedShare: approved > 0 ? matched / approved : null,
    matchedRevenueCents: matchedRevenue,
    unmatchedApprovedCount: approved - matched,
    unmatchedRevenueCents: unmatchedRevenue,
    refundCount,
    refundCents,
    pendingCount,
    pendingCents,
    trialCount: trials,
    trialConvertedCount: trialsConverted,
    otherCurrencySpend,
  };
}

/** Variação relativa (0,12 = +12%). Sem base, não há comparação. */
export function change(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

export type DailyPoint = {
  key: string;
  label: string;
  spendCents: number;
  revenueCents: number;
  sales: number;
};

const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: "UTC" });

function dayLabel(ymd: string, short: boolean): string {
  const [, m, d] = ymd.split("-");
  if (short) return `${weekday.format(new Date(`${ymd}T12:00:00Z`)).replace(".", "")} ${d}`;
  return `${d}/${m}`;
}

/** Gasto e faturamento por dia; num período de um dia, faturamento por hora. */
export function dailySeries(
  sales: ResultSale[],
  insights: InsightRow[],
  days: { first: string; last: string },
  timeZone: string,
  currency: string,
): { mode: "day" | "hour"; points: DailyPoint[] } {
  const approved = sales.filter((s) => s.status === "approved" && s.currency === currency);
  if (days.first === days.last) {
    const hourOf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    });
    const points: DailyPoint[] = Array.from({ length: 24 }, (_, h) => ({
      key: String(h),
      label: `${String(h).padStart(2, "0")}h`,
      spendCents: 0,
      revenueCents: 0,
      sales: 0,
    }));
    for (const s of approved) {
      const hour = Number(hourOf.format(new Date(saleInstant(s)))) % 24;
      points[hour]!.revenueCents += s.gross_amount_cents;
      points[hour]!.sales++;
    }
    return { mode: "hour", points };
  }
  const all = eachDay(days.first, days.last);
  const short = all.length <= 7;
  const byDay = new Map<string, DailyPoint>(
    all.map((d) => [
      d,
      { key: d, label: dayLabel(d, short), spendCents: 0, revenueCents: 0, sales: 0 },
    ]),
  );
  for (const s of approved) {
    const p = byDay.get(ymdInZone(new Date(saleInstant(s)), timeZone));
    if (!p) continue;
    p.revenueCents += s.gross_amount_cents;
    p.sales++;
  }
  for (const r of insights) {
    const p = byDay.get(r.date);
    if (p && r.currency === currency) p.spendCents += r.spend_cents;
  }
  return { mode: "day", points: [...byDay.values()] };
}

export type NodeMetrics = {
  spendCents: number;
  impressions: number;
  linkClicks: number;
  /** Todos os cliques (link, perfil, curtir...), como a Meta conta. */
  allClicks: number;
  registrations: number;
  trials: number;
  /** Ações da Meta somadas (action_type → quantidade). */
  actions: Record<string, number>;
  /** Eventos do script de rastreamento ligados a este nível (cadastro → quantidade). */
  tracked: Record<string, number>;
  sales: number;
  revenueCents: number;
  feesCents: number;
  costCents: number;
};

export type Level = "campaign" | "adset" | "ad";

export type Budget = { kind: "daily" | "lifetime"; cents: number };

export type TreeNode = {
  id: string;
  level: Level;
  name: string;
  accountId: string;
  /** Entrega real (effective_status). */
  status: string | null;
  /** Status escolhido na Meta (ACTIVE/PAUSED): é o que a chave liga e desliga. */
  configuredStatus: string | null;
  /** Orçamento próprio. Nulo em anúncio, em conjunto de campanha CBO e antes da sincronização. */
  budget: Budget | null;
  /** Conjunto cuja campanha tem orçamento (CBO): o orçamento se muda na campanha. */
  usesCampaignBudget: boolean;
  thumbnailUrl: string | null;
  previewLink: string | null;
  metrics: NodeMetrics;
  children: TreeNode[];
};

const emptyMetrics = (): NodeMetrics => ({
  spendCents: 0,
  impressions: 0,
  linkClicks: 0,
  allClicks: 0,
  registrations: 0,
  trials: 0,
  actions: {},
  tracked: {},
  sales: 0,
  revenueCents: 0,
  feesCents: 0,
  costCents: 0,
});

export const derived = {
  ctr: (m: NodeMetrics) => (m.impressions > 0 ? m.linkClicks / m.impressions : null),
  cpc: (m: NodeMetrics) => (m.linkClicks > 0 ? Math.round(m.spendCents / m.linkClicks) : null),
  roas: (m: NodeMetrics) => (m.spendCents > 0 ? m.revenueCents / m.spendCents : null),
  cpa: (m: NodeMetrics) =>
    m.sales > 0 && m.spendCents > 0 ? Math.round(m.spendCents / m.sales) : null,
  profit: (m: NodeMetrics) => m.revenueCents - m.feesCents - m.costCents - m.spendCents,
};

export function budgetOf(
  e: Pick<CampaignEntity, "daily_budget_cents" | "lifetime_budget_cents">,
): Budget | null {
  if (e.daily_budget_cents) return { kind: "daily", cents: e.daily_budget_cents };
  if (e.lifetime_budget_cents) return { kind: "lifetime", cents: e.lifetime_budget_cents };
  return null;
}

function isRelevant(node: TreeNode, keep?: ReadonlySet<string>): boolean {
  return (
    node.metrics.spendCents > 0 ||
    node.metrics.sales > 0 ||
    node.metrics.registrations > 0 ||
    node.metrics.trials > 0 ||
    Object.keys(node.metrics.tracked).length > 0 ||
    node.status === "ACTIVE" ||
    !!keep?.has(node.id)
  );
}

/**
 * Árvore do Gerenciador de Anúncios. Gasto sobe dos anúncios para conjunto e campanha;
 * vendas contam em cada nível pelo id atribuído (uma venda só com campanha conta na
 * campanha, mesmo sem anúncio). Ficam as linhas com gasto, venda ou status ativo, e as de
 * `keep` (ex.: acabou de ser pausada pelo app e não pode sumir da tela).
 */
export function buildTree(
  structure: AdStructure,
  sales: ResultSale[],
  insights: InsightRow[],
  products: Map<string, ProductCost>,
  currency: string,
  accountId: string | null,
  keep?: ReadonlySet<string>,
  events: TrackingEvent[] = [],
): TreeNode[] {
  const inAccount = <T extends { ad_account_id: string }>(e: T) =>
    !accountId || e.ad_account_id === accountId;
  const node = (
    e: CampaignEntity & { thumbnail_url?: string | null; preview_link?: string | null },
    level: Level,
  ): TreeNode => ({
    id: e.id,
    level,
    name: e.name,
    accountId: e.ad_account_id,
    status: e.effective_status,
    configuredStatus: e.status ?? null,
    budget: level === "ad" ? null : budgetOf(e),
    usesCampaignBudget: false,
    thumbnailUrl: e.thumbnail_url ?? null,
    previewLink: e.preview_link ?? null,
    metrics: emptyMetrics(),
    children: [],
  });
  const campaigns = new Map(
    structure.campaigns.filter(inAccount).map((c) => [c.id, node(c, "campaign")]),
  );
  const adsets = new Map(structure.adsets.filter(inAccount).map((a) => [a.id, node(a, "adset")]));
  const ads = new Map(structure.ads.filter(inAccount).map((a) => [a.id, node(a, "ad")]));
  const adParent = new Map(structure.ads.map((a) => [a.id, a]));
  const adsetParent = new Map(structure.adsets.map((a) => [a.id, a.campaign_id]));

  for (const r of insights) {
    if (r.currency !== currency) continue;
    const ad = adParent.get(r.ad_id);
    const targets = [
      ads.get(r.ad_id),
      ad && adsets.get(ad.adset_id),
      ad && campaigns.get(ad.campaign_id),
    ];
    for (const t of targets) {
      if (!t) continue;
      t.metrics.spendCents += r.spend_cents;
      t.metrics.impressions += r.impressions;
      t.metrics.linkClicks += r.link_clicks;
      t.metrics.registrations += r.registrations;
      t.metrics.trials += r.trials;
      t.metrics.allClicks += r.clicks;
      addActions(t.metrics.actions, r.actions);
    }
  }
  for (const s of sales) {
    if (s.status !== "approved" || s.currency !== currency) continue;
    const d = saleDeductions(s, s.product_id ? products.get(s.product_id) : undefined);
    const targets = [
      s.campaign_id ? campaigns.get(s.campaign_id) : undefined,
      s.adset_id ? adsets.get(s.adset_id) : undefined,
      s.ad_id ? ads.get(s.ad_id) : undefined,
    ];
    for (const t of targets) {
      if (!t) continue;
      t.metrics.sales++;
      t.metrics.revenueCents += s.gross_amount_cents;
      t.metrics.feesCents += d.fees;
      t.metrics.costCents += d.cost;
    }
  }
  for (const e of events) {
    const targets = [
      e.campaign_id ? campaigns.get(e.campaign_id) : undefined,
      e.adset_id ? adsets.get(e.adset_id) : undefined,
      e.ad_id ? ads.get(e.ad_id) : undefined,
    ];
    for (const t of targets)
      if (t) t.metrics.tracked[e.event] = (t.metrics.tracked[e.event] ?? 0) + 1;
  }
  for (const a of structure.ads) {
    const n = ads.get(a.id);
    if (n && isRelevant(n, keep)) adsets.get(a.adset_id)?.children.push(n);
  }
  for (const a of structure.adsets) {
    const n = adsets.get(a.id);
    const parent = campaigns.get(adsetParent.get(a.id) ?? "");
    if (n && parent?.budget) n.usesCampaignBudget = true;
    if (n && (isRelevant(n, keep) || n.children.length)) parent?.children.push(n);
  }
  const bySpend = (a: TreeNode, b: TreeNode) =>
    b.metrics.spendCents - a.metrics.spendCents || b.metrics.revenueCents - a.metrics.revenueCents;
  const roots = [...campaigns.values()].filter((c) => isRelevant(c, keep) || c.children.length);
  for (const c of roots) {
    c.children.sort(bySpend);
    for (const a of c.children) a.children.sort(bySpend);
  }
  return roots.sort(bySpend);
}

export type OriginGroup = {
  key: string;
  name: string;
  path: string | null;
  thumbnailUrl: string | null;
  sales: number;
  revenueCents: number;
};

/** Criativos (ou UTMs, sem a Meta) que mais venderam no período. */
export function topOrigins(sales: ResultSale[], currency: string, limit = 5): OriginGroup[] {
  const groups = new Map<string, OriginGroup>();
  for (const s of sales) {
    if (s.status !== "approved" || s.currency !== currency) continue;
    const name = s.ad?.name ?? s.utm_content?.split("|")[0]?.trim();
    if (!name) continue;
    const key = s.ad?.id ?? `utm:${name}`;
    const path = [s.campaign?.name, s.adset?.name].filter(Boolean).join(" › ") || null;
    const g = groups.get(key) ?? {
      key,
      name,
      path,
      thumbnailUrl: s.ad?.thumbnail_url ?? null,
      sales: 0,
      revenueCents: 0,
    };
    g.sales++;
    g.revenueCents += s.gross_amount_cents;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.revenueCents - a.revenueCents || b.sales - a.sales)
    .slice(0, limit);
}

export type UnmatchedDiagnosis = {
  partial: number;
  unattributed: number;
  revenueCents: number;
  /** UTMs que chegaram e não casaram com nada sincronizado, mais frequentes primeiro. */
  topUtms: { value: string; count: number }[];
};

export function diagnoseUnmatched(sales: ResultSale[], currency: string): UnmatchedDiagnosis {
  let partial = 0;
  let unattributed = 0;
  let revenue = 0;
  const utms = new Map<string, number>();
  for (const s of sales) {
    if (s.attribution_status === "matched" || s.status === "canceled") continue;
    if (s.attribution_status === "partial") {
      partial++;
      const value = s.utm_content ?? s.utm_campaign;
      if (value) utms.set(value, (utms.get(value) ?? 0) + 1);
    } else unattributed++;
    if (s.status === "approved" && s.currency === currency) revenue += s.gross_amount_cents;
  }
  return {
    partial,
    unattributed,
    revenueCents: revenue,
    topUtms: [...utms.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}
