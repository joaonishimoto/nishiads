import { Fragment, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  AlertTriangle,
  CircleDashed,
  Coins,
  FlaskConical,
  Plug,
  Receipt,
  RefreshCw,
  Search,
  Sparkles,
  Tags,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  EmptyState,
  LoadError,
  PageHeader,
  PageSkeleton,
  Panel,
  Status,
} from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { useReattributeSales, useSalesRealtime } from "@/features/sales/api";
import { ATTRIBUTION_META } from "@/features/sales/meta";
import { originParts } from "@/features/sales/attribution-path";
import { FilterBar, useResultFilters, type ResultFiltersState } from "@/features/results/filters";
import { useResults } from "@/features/results/use-results";
import {
  change,
  diagnoseUnmatched,
  saleInstant,
  topOrigins,
  type ResultSale,
} from "@/features/results/metrics";
import { addDays, ymdInZone } from "@/lib/period";
import {
  fmt,
  LiveBadge,
  MetricCard,
  RoasTargetButton,
  SpendRevenueChart,
  Thumb,
  useRoasTarget,
} from "@/features/results/components";
import { CampaignRanking, flattenAds, TopCreatives } from "@/features/results/campaign-visuals";
import { ProductCostsDialog } from "@/features/results/product-costs";
import { SaleLine, useFreshIds } from "@/features/results/recent-sales";
import { ViewPicker, useViewItems } from "@/features/views/view-picker";
import type { ViewCatalog } from "@/features/views/catalog";
import { friendlyError } from "@/lib/errors";
import { formatMoney, plural } from "@/lib/format";
import { splitUtmRef } from "@/lib/utm";
import { cn } from "@/lib/utils";
import type { SaleStatus } from "@/types/database";

type View = "all" | "unmatched" | "trials";
const VIEW_PARAM: Record<View, string | null> = {
  all: null,
  unmatched: "sem-origem",
  trials: "testes",
};

type StatusFilter = "all" | "approved" | "pending" | "refunds" | "canceled";
const STATUS_FILTERS: { key: StatusFilter; label: string; match: (s: SaleStatus) => boolean }[] = [
  { key: "all", label: "Todas", match: (s) => s !== "trialing" },
  { key: "approved", label: "Aprovadas", match: (s) => s === "approved" },
  { key: "pending", label: "Pendentes", match: (s) => s === "pending" },
  { key: "refunds", label: "Reembolsos", match: (s) => s === "refunded" || s === "chargeback" },
  { key: "canceled", label: "Recusadas", match: (s) => s === "canceled" },
];

const CARD_LABELS = {
  revenue: "Faturamento",
  spend: "Gasto",
  profit: "Lucro",
  roas: "ROAS",
  cpa: "CPA",
  approved: "Vendas aprovadas",
  ticket: "Ticket médio",
  matched: "Com origem",
  impressions: "Impressões",
  clicks: "Cliques no link",
  ctr: "CTR",
  cpc: "CPC",
  cpm: "CPM",
  fees: "Taxas e custos",
} as const;
type CardKey = keyof typeof CARD_LABELS;

const STRIP_LABELS = {
  pending: "Pendentes",
  refunds: "Reembolsos e chargebacks",
  trials: "Testes iniciados",
  refund_rate: "Taxa de reembolso",
} as const;
type StripKey = keyof typeof STRIP_LABELS;

const SECTION_LABELS = {
  chart: "Gráfico de gasto × faturamento",
  origins: "Criativos que mais venderam",
  ranking: "Ranking de campanhas",
  creatives: "Criativos que mais dão lucro",
  sales: "Lista de vendas",
} as const;

/** O que cada métrica mede, ao lado do nome no editor de template. */
const CARD_HINTS: Partial<Record<CardKey, string>> = {
  revenue: "valor bruto das vendas aprovadas",
  spend: "quanto a Meta cobrou",
  profit: "faturamento − taxas − custos − gasto",
  roas: "retorno sobre o gasto: faturamento ÷ gasto",
  cpa: "custo por aquisição: gasto ÷ vendas",
  ticket: "faturamento ÷ vendas",
  matched: "vendas ligadas a um anúncio",
  ctr: "taxa de cliques: cliques ÷ impressões",
  cpc: "custo por clique",
  cpm: "custo por mil impressões",
  fees: "taxas do checkout e custo dos produtos",
};
const STRIP_HINTS: Partial<Record<StripKey, string>> = {
  trials: "assinaturas no período grátis",
  refund_rate: "reembolsos ÷ vendas",
};

const EXTRA_CARDS: CardKey[] = ["impressions", "clicks", "ctr", "cpc", "cpm", "fees"];

/** O que dá para ligar e desligar no Dashboard; sem template, fica como sempre foi. */
const DASHBOARD_VIEW: ViewCatalog = {
  groups: [
    { key: "cards", label: "Cartões de métricas", reorder: true },
    { key: "strip", label: "Linha de resumo", reorder: true },
    { key: "sections", label: "Seções", reorder: false },
  ],
  options: [
    ...Object.entries(CARD_LABELS).map(([key, label]) => ({
      key,
      label,
      group: "cards",
      hint: CARD_HINTS[key as CardKey],
    })),
    ...Object.entries(STRIP_LABELS).map(([key, label]) => ({
      key,
      label,
      group: "strip",
      hint: STRIP_HINTS[key as StripKey],
    })),
    ...Object.entries(SECTION_LABELS).map(([key, label]) => ({ key, label, group: "sections" })),
  ],
  defaults: [
    ...(Object.keys(CARD_LABELS) as CardKey[]).filter((k) => !EXTRA_CARDS.includes(k)),
    ...Object.keys(STRIP_LABELS),
    ...Object.keys(SECTION_LABELS),
  ],
};

/** Métricas gerais do negócio (faturamento, gasto, lucro, ROAS, CPA) e a lista de vendas. */
export function DashboardPage() {
  const { workspace } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const view: View =
    params.get("visao") === "sem-origem"
      ? "unmatched"
      : params.get("visao") === "testes"
        ? "trials"
        : "all";
  const filters = useResultFilters();
  const results = useResults(filters, { tree: true });
  const [costsOpen, setCostsOpen] = useState(false);
  useSalesRealtime(workspace.id);

  const setView = (v: View) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const value = VIEW_PARAM[v];
        if (value) next.set("visao", value);
        else next.delete("visao");
        next.delete("status");
        return next;
      },
      { replace: true },
    );

  const header = (
    <PageHeader
      title="Dashboard"
      subtitle="Faturamento, gasto, lucro, ROAS e CPA do período, com cada venda e a origem dela."
      actions={
        <>
          <LiveBadge />
          {view === "all" && <ViewPicker page="dashboard" catalog={DASHBOARD_VIEW} />}
          <Button variant="outline" onClick={() => setCostsOpen(true)}>
            <Coins />
            Custos
          </Button>
        </>
      }
    />
  );
  if (results.isPending && !results.computed) return <PageSkeleton variant="table" />;
  if (!results.computed) {
    return (
      <div className="space-y-5">
        {header}
        <LoadError onRetry={results.retry} retrying={results.isFetching}>
          Não foi possível carregar o dashboard.
        </LoadError>
      </div>
    );
  }

  const { sales } = results.computed;
  const unmatched = sales.filter(
    (s) => s.attribution_status !== "matched" && s.status !== "trialing",
  );
  const trials = sales.filter((s) => s.status === "trialing");
  const tabs: { key: View; label: string; count?: number }[] = [
    { key: "all", label: "Resumo" },
    { key: "unmatched", label: "Sem origem", count: unmatched.length },
    ...(trials.length > 0 || view === "trials"
      ? [{ key: "trials" as const, label: "Testes", count: trials.length }]
      : []),
  ];

  return (
    <div className="space-y-5">
      {header}
      <FilterBar
        filters={filters}
        accounts={results.tracked.map((a) => ({ id: a.id, name: a.name }))}
        products={results.products}
      />
      {results.isError && (
        <LoadError onRetry={results.retry} retrying={results.isFetching}>
          Parte dos dados não carregou. Os números podem estar incompletos.
        </LoadError>
      )}
      {filters.accountId && (
        <p className="text-xs text-muted-foreground">
          Com uma conta escolhida, entram só as vendas atribuídas às campanhas dela.
        </p>
      )}

      <div
        className="flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--border)] [scrollbar-width:none]"
        role="tablist"
        aria-label="Visão"
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={view === tab.key}
            onClick={() => setView(tab.key)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
              view === tab.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">
                {fmt.int(tab.count)}
              </span>
            )}
          </button>
        ))}
      </div>

      {view === "all" && (
        <AllView results={results} filters={filters} onOpenCosts={() => setCostsOpen(true)} />
      )}
      {view === "unmatched" && <UnmatchedView sales={unmatched} />}
      {view === "trials" && <TrialsView trials={trials} />}

      <ProductCostsDialog
        open={costsOpen}
        onOpenChange={setCostsOpen}
        products={results.products}
      />
    </div>
  );
}

function AllView({
  results,
  filters,
  onOpenCosts,
}: {
  results: ReturnType<typeof useResults>;
  filters: ResultFiltersState;
  onOpenCosts: () => void;
}) {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const base = `/w/${workspace.id}`;
  const cur = workspace.currency;
  const [target, setTarget] = useRoasTarget(workspace.id);
  const { sales, totals: t, previous: p, series, tree: rawTree } = results.computed!;
  const tree = rawTree ?? [];
  const meta = results.metaConnected;
  const comparison = filters.comparisonLabel;
  const creatives = useMemo(() => flattenAds(tree), [tree]);
  // Hoje: a Meta só tem o gasto do dia inteiro de ontem, então gasto e derivados ficam sem comparação.
  const spendChange = (a: number | null, b: number | null) =>
    filters.partialComparison ? null : change(a, b);
  const noCosts =
    results.products.length > 0 &&
    results.products.every((x) => !x.cost_cents && !x.fee_percent_bps && !x.fee_fixed_cents);
  const openCampaigns = (aba?: string) =>
    navigate({ pathname: `${base}/campanhas`, search: aba ? `?aba=${aba}` : "" });
  const [params, setParams] = useSearchParams();
  const status = (STATUS_FILTERS.find((f) => f.key === params.get("status"))?.key ??
    "all") as StatusFilter;
  const origins = useMemo(() => topOrigins(sales, cur), [sales, cur]);
  const match = STATUS_FILTERS.find((f) => f.key === status)!.match;
  const visible = sales.filter((s) => match(s.status));
  const counts = Object.fromEntries(
    STATUS_FILTERS.map((f) => [f.key, sales.filter((s) => f.match(s.status)).length]),
  );
  const { items, shown } = useViewItems("dashboard", DASHBOARD_VIEW);
  const cardKeys = items.filter((k): k is CardKey => k in CARD_LABELS);
  const stripKeys = items.filter((k): k is StripKey => k in STRIP_LABELS);
  const ctr = (x: { impressions: number; linkClicks: number } | null) =>
    x && x.impressions > 0 ? x.linkClicks / x.impressions : null;
  const cpc = (x: { spendCents: number; linkClicks: number } | null) =>
    x && x.linkClicks > 0 ? Math.round(x.spendCents / x.linkClicks) : null;
  const cpm = (x: { spendCents: number; impressions: number } | null) =>
    x && x.impressions > 0 ? Math.round((x.spendCents / x.impressions) * 1000) : null;
  const metaHint = meta ? comparison : "conecte a Meta";

  const cards: Record<CardKey, (emphasis: boolean) => React.ReactNode> = {
    revenue: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.revenue}
        value={formatMoney(t.revenueCents, cur)}
        delta={change(t.revenueCents, p?.revenueCents ?? null)}
        hint={comparison}
      />
    ),
    spend: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.spend}
        value={meta ? formatMoney(t.spendCents, cur) : "—"}
        delta={meta ? spendChange(t.spendCents, p?.spendCents ?? null) : null}
        invert
        hint={filters.productId ? "de todas as campanhas" : metaHint}
        info={
          filters.productId
            ? "A Meta não separa gasto por produto: o gasto é o das campanhas filtradas."
            : undefined
        }
      />
    ),
    profit: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.profit}
        value={formatMoney(t.profitCents, cur)}
        tone={t.profitCents < 0 ? "danger" : t.profitCents > 0 ? "success" : undefined}
        delta={spendChange(t.profitCents, p?.profitCents ?? null)}
        hint={
          noCosts ? (
            <button
              type="button"
              className="underline-offset-2 hover:text-primary hover:underline"
              onClick={onOpenCosts}
            >
              informe os custos
            </button>
          ) : (
            comparison
          )
        }
        info="Faturamento − taxas do checkout − custo dos produtos − gasto em anúncios."
      />
    ),
    roas: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.roas}
        value={fmt.roas(t.roas)}
        delta={spendChange(t.roas, p?.roas ?? null)}
        hint={t.roas === null ? "sem gasto no período" : `meta ${fmt.roas(target)}`}
        info="Faturamento dividido pelo gasto. Inclui vendas sem origem identificada."
      />
    ),
    cpa: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.cpa}
        value={fmt.money(t.cpaCents, cur)}
        delta={spendChange(t.cpaCents, p?.cpaCents ?? null)}
        invert
        hint="custo por venda"
      />
    ),
    approved: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.approved}
        value={fmt.int(t.approvedCount)}
        delta={change(t.approvedCount, p?.approvedCount ?? null)}
        hint={comparison}
      />
    ),
    ticket: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.ticket}
        value={fmt.money(t.ticketCents, cur)}
        delta={change(t.ticketCents, p?.ticketCents ?? null)}
        hint={comparison}
      />
    ),
    matched: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.matched}
        value={fmt.pct(t.matchedShare)}
        hint={
          t.approvedCount
            ? `${formatMoney(t.matchedRevenueCents, cur)} atribuídos`
            : "sem vendas no período"
        }
        info="Vendas aprovadas ligadas a campanha, conjunto e criativo."
      />
    ),
    impressions: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.impressions}
        value={meta ? fmt.int(t.impressions) : "—"}
        delta={meta ? spendChange(t.impressions, p?.impressions ?? null) : null}
        hint={metaHint}
      />
    ),
    clicks: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.clicks}
        value={meta ? fmt.int(t.linkClicks) : "—"}
        delta={meta ? spendChange(t.linkClicks, p?.linkClicks ?? null) : null}
        hint={metaHint}
      />
    ),
    ctr: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.ctr}
        value={meta ? fmt.pct(ctr(t), 2) : "—"}
        delta={meta ? spendChange(ctr(t), ctr(p)) : null}
        hint={metaHint}
        info="Cliques no link divididos pelas impressões."
      />
    ),
    cpc: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.cpc}
        value={meta ? fmt.money(cpc(t), cur) : "—"}
        delta={meta ? spendChange(cpc(t), cpc(p)) : null}
        invert
        hint={meta ? "custo por clique no link" : metaHint}
      />
    ),
    cpm: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.cpm}
        value={meta ? fmt.money(cpm(t), cur) : "—"}
        delta={meta ? spendChange(cpm(t), cpm(p)) : null}
        invert
        hint={meta ? "custo por mil impressões" : metaHint}
      />
    ),
    fees: (emphasis) => (
      <MetricCard
        emphasis={emphasis}
        label={CARD_LABELS.fees}
        value={formatMoney(t.feesCents + t.costCents, cur)}
        delta={change(t.feesCents + t.costCents, p ? p.feesCents + p.costCents : null)}
        invert
        hint={noCosts ? "informe os custos" : comparison}
        info="Taxas do checkout mais o custo dos produtos vendidos, como cadastrado em Custos."
      />
    ),
  };

  const strip: Record<StripKey, React.ReactNode> = {
    pending: (
      <QuickStat
        label={STRIP_LABELS.pending}
        value={
          t.pendingCount ? `${fmt.int(t.pendingCount)} · ${formatMoney(t.pendingCents, cur)}` : "0"
        }
      />
    ),
    refunds: (
      <QuickStat
        label={STRIP_LABELS.refunds}
        value={
          t.refundCount ? `${fmt.int(t.refundCount)} · ${formatMoney(t.refundCents, cur)}` : "0"
        }
        tone={t.refundCount ? "danger" : undefined}
      />
    ),
    trials:
      t.trialCount > 0 ? (
        <QuickStat
          label={STRIP_LABELS.trials}
          value={`${fmt.int(t.trialCount)} · ${fmt.pct(t.trialConvertedCount / t.trialCount)} pagaram`}
        />
      ) : null,
    refund_rate: (
      <QuickStat
        label={STRIP_LABELS.refund_rate}
        value={
          t.approvedCount + t.refundCount
            ? fmt.pct(t.refundCount / (t.approvedCount + t.refundCount), 1)
            : "—"
        }
      />
    ),
  };
  const showChart = shown.has("chart");
  const showOrigins = shown.has("origins");
  const showRanking = meta && shown.has("ranking");
  const showCreatives = meta && shown.has("creatives");

  return (
    <div className="space-y-5">
      {!meta && (
        <Panel>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-primary">
                <Plug className="h-4 w-4" />
              </span>
              <div className="text-sm">
                <p className="font-medium text-foreground">
                  Conecte a Meta Ads para ver gasto, ROAS e lucro
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  Por enquanto, mostramos só o que veio das vendas.
                </p>
              </div>
            </div>
            <Button asChild className="shrink-0">
              <Link to={`${base}/integracoes`}>Conectar Meta Ads</Link>
            </Button>
          </div>
        </Panel>
      )}

      {cardKeys.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          {cardKeys.map((key, i) => (
            <Fragment key={key}>{cards[key](i === 0)}</Fragment>
          ))}
        </div>
      )}
      {t.otherCurrencySpend && (
        <p className="flex items-start gap-2 text-xs text-warning-strong">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          Há conta de anúncio em outra moeda. O gasto dela fica fora dos totais em {cur}.
        </p>
      )}
      {stripKeys.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm sm:flex sm:flex-wrap sm:gap-x-8">
          {stripKeys.map((key) => (
            <Fragment key={key}>{strip[key]}</Fragment>
          ))}
        </dl>
      )}

      {(showChart || showOrigins) && (
        <div
          className={cn(
            "grid grid-cols-[minmax(0,1fr)] gap-4",
            showChart && showOrigins && "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]",
          )}
        >
          {showChart && (
            <Panel
              title={
                series.mode === "hour"
                  ? "Faturamento por hora"
                  : meta
                    ? "Gasto × faturamento por dia"
                    : "Faturamento por dia"
              }
              description={
                series.mode === "hour"
                  ? meta
                    ? "A Meta informa o gasto por dia, não por hora."
                    : `${plural(t.approvedCount, "venda aprovada", "vendas aprovadas")} no período`
                  : `${formatMoney(t.revenueCents, cur)} faturados${meta ? ` · ${formatMoney(t.spendCents, cur)} investidos` : ""}`
              }
            >
              <SpendRevenueChart
                points={series.points}
                mode={series.mode}
                currency={cur}
                showSpend={meta}
              />
            </Panel>
          )}
          {showOrigins && (
            <Panel
              title="Criativos que mais venderam"
              action={
                <Link
                  to={`${base}/campanhas?aba=criativos`}
                  className="shrink-0 text-xs font-medium text-primary hover:underline"
                >
                  Ver métricas
                </Link>
              }
            >
              {origins.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Quando as vendas chegarem com UTMs, os criativos que mais vendem aparecem aqui.
                </p>
              ) : (
                <ol className="divide-y divide-border">
                  {origins.map((o, i) => (
                    <li key={o.key} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="w-4 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                        {i + 1}
                      </span>
                      <Thumb src={o.thumbnailUrl} alt="" size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{o.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {o.path ?? "Só pelo UTM"}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-semibold tabular-nums text-foreground">
                          {formatMoney(o.revenueCents, cur)}
                        </p>
                        <p className="text-xs tabular-nums text-muted-foreground">
                          {plural(o.sales, "venda", "vendas")}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
          )}
        </div>
      )}

      {(showRanking || showCreatives) && (
        <div
          className={cn(
            "grid grid-cols-[minmax(0,1fr)] gap-4",
            showRanking && showCreatives && "lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]",
          )}
        >
          {showRanking && (
            <Panel
              title="Campanhas"
              description="Faturamento contra gasto de cada campanha, na mesma escala."
              action={<RoasTargetButton target={target} onChange={setTarget} />}
            >
              {tree.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Nenhuma campanha com gasto no período.
                </p>
              ) : (
                <CampaignRanking
                  nodes={tree}
                  currency={cur}
                  target={target}
                  onOpenAll={() => openCampaigns()}
                />
              )}
            </Panel>
          )}
          {showCreatives && (
            <Panel title="Criativos que mais dão lucro">
              <TopCreatives
                items={creatives}
                currency={cur}
                target={target}
                onOpenAll={creatives.length ? () => openCampaigns("criativos") : undefined}
              />
            </Panel>
          )}
        </div>
      )}

      {shown.has("sales") && (
        <SalesFeed
          sales={visible}
          chips={
            <div
              className="flex gap-1.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
              role="group"
              aria-label="Status"
            >
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={status === f.key}
                  onClick={() =>
                    setParams(
                      (prev) => {
                        const next = new URLSearchParams(prev);
                        if (f.key === "all") next.delete("status");
                        else next.set("status", f.key);
                        return next;
                      },
                      { replace: true },
                    )
                  }
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                    status === f.key
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-surface text-muted-foreground hover:border-border-strong hover:text-foreground",
                  )}
                >
                  {f.label}
                  <span className="tabular-nums opacity-80">{fmt.int(counts[f.key] ?? 0)}</span>
                </button>
              ))}
            </div>
          }
          empty={
            sales.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="Nenhuma venda no período"
                description="As vendas aparecem aqui na hora em que o checkout enviar o webhook."
                action={
                  <Button variant="outline" asChild>
                    <Link to={`${base}/integracoes`}>Conectar checkout</Link>
                  </Button>
                }
              />
            ) : undefined
          }
        />
      )}
    </div>
  );
}

function QuickStat({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "truncate font-medium tabular-nums",
          tone === "danger" ? "text-danger-strong" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

const PAGE = 50;

const filtersToday = (timeZone: string) => ymdInZone(new Date(), timeZone);
const dayFormat = new Intl.DateTimeFormat("pt-BR", {
  weekday: "long",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** "Hoje", "Ontem" ou "sexta-feira, 23 de out.". */
function dayHeading(day: string, today: string): string {
  if (day === today) return "Hoje";
  if (day === addDays(today, -1)) return "Ontem";
  const text = dayFormat.format(new Date(`${day}T12:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Lista das vendas do recorte, mais recentes primeiro; as que chegam ao vivo piscam em verde. */
function SalesFeed({
  sales,
  chips,
  empty,
}: {
  sales: ResultSale[];
  chips?: React.ReactNode;
  empty?: React.ReactNode;
}) {
  const [limit, setLimit] = useState(PAGE);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sales.filter((s) =>
        [s.product_name ?? "", s.external_order_id, ...originParts(s)].some((v) =>
          v.toLowerCase().includes(q),
        ),
      )
    : sales;
  const shown = filtered.slice(0, limit);
  const fresh = useFreshIds(sales.slice(0, 20).map((s) => s.id));
  const { workspace } = useWorkspace();
  const byDay = useMemo(() => {
    const map = new Map<string, { count: number; cents: number }>();
    for (const s of filtered) {
      if (s.status !== "approved") continue;
      const day = ymdInZone(new Date(saleInstant(s)), workspace.timezone);
      const t = map.get(day) ?? { count: 0, cents: 0 };
      t.count++;
      if (s.currency === workspace.currency) t.cents += s.gross_amount_cents;
      map.set(day, t);
    }
    return map;
  }, [filtered, workspace.timezone, workspace.currency]);
  if (empty) return <>{empty}</>;
  return (
    <Panel>
      <div className="space-y-2 border-b border-border bg-surface-muted px-3 py-2.5">
        {chips}
        <div className="flex items-center gap-3">
          <div className="relative min-w-0 flex-1 sm:max-w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar produto, pedido ou anúncio"
              aria-label="Buscar venda"
              className="h-8 bg-surface pl-8 pr-8 text-sm"
            />
            {query && (
              <button
                type="button"
                aria-label="Limpar busca"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface-hover hover:text-primary"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
            {plural(filtered.length, "venda", "vendas")}
          </span>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          Nenhuma venda com esse filtro.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((s, i) => {
            const day = ymdInZone(new Date(saleInstant(s)), workspace.timezone);
            const header =
              i === 0 ||
              day !== ymdInZone(new Date(saleInstant(shown[i - 1]!)), workspace.timezone);
            const total = byDay.get(day);
            return (
              <Fragment key={s.id}>
                {header && (
                  <li className="flex items-center justify-between gap-3 bg-surface-muted px-4 py-1.5 text-xs">
                    <span className="font-medium text-foreground">
                      {dayHeading(day, filtersToday(workspace.timezone))}
                    </span>
                    {total && total.count > 0 && (
                      <span className="tabular-nums text-muted-foreground">
                        {plural(total.count, "aprovada", "aprovadas")} ·{" "}
                        {formatMoney(total.cents, workspace.currency)}
                      </span>
                    )}
                  </li>
                )}
                <SaleLine sale={s} fresh={fresh.has(s.id)} />
              </Fragment>
            );
          })}
        </ul>
      )}
      {filtered.length > limit && (
        <div className="flex justify-center border-t border-border p-3">
          <Button variant="outline" onClick={() => setLimit((n) => n + PAGE)}>
            Mostrar mais {Math.min(PAGE, filtered.length - limit)}
          </Button>
        </div>
      )}
    </Panel>
  );
}

function UnmatchedView({ sales }: { sales: ResultSale[] }) {
  const { workspace, canManage } = useWorkspace();
  const reattribute = useReattributeSales(workspace.id);
  const d = useMemo(
    () => diagnoseUnmatched(sales, workspace.currency),
    [sales, workspace.currency],
  );
  const base = `/w/${workspace.id}`;

  if (sales.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="Nenhuma venda sem origem"
        description="Todas as vendas deste período foram ligadas a um criativo. Os UTMs estão funcionando."
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <DiagnosisCard
          icon={Tags}
          tone="warning"
          count={d.partial}
          title={ATTRIBUTION_META.partial.label}
          text={`${ATTRIBUTION_META.partial.description} Sincronize a Meta ou refaça a atribuição.`}
        />
        <DiagnosisCard
          icon={CircleDashed}
          tone="neutral"
          count={d.unattributed}
          title={ATTRIBUTION_META.unattributed.label}
          text={ATTRIBUTION_META.unattributed.description}
          action={
            <Link to={`${base}/ajuda`} className="text-xs font-medium text-primary hover:underline">
              Ver como configurar os UTMs
            </Link>
          }
        />
      </div>

      <Panel>
        <div className="grid gap-3 p-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div>
            <p className="font-medium text-foreground">
              {formatMoney(d.revenueCents, workspace.currency)} em vendas aprovadas sem criativo
              identificado
            </p>
            <p className="mt-0.5 text-muted-foreground">
              Depois de sincronizar a Meta ou corrigir um nome de anúncio, refaça a atribuição: as
              vendas antigas são ligadas de novo.
            </p>
          </div>
          {canManage && (
            <Button
              variant="outline"
              loading={reattribute.isPending}
              loadingText="Refazendo…"
              onClick={() =>
                reattribute.mutate(undefined, {
                  onSuccess: (matched) =>
                    toast.success(
                      matched
                        ? `${plural(matched, "venda atribuída", "vendas atribuídas")} agora.`
                        : "Nenhuma venda nova atribuída.",
                    ),
                  onError: (error) => toast.error(friendlyError(error)),
                })
              }
            >
              <RefreshCw />
              Refazer atribuição
            </Button>
          )}
        </div>
        {d.topUtms.length > 0 && (
          <div className="border-t border-border px-4 py-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              UTMs que chegaram e não casaram com nenhum anúncio
            </p>
            <ul className="space-y-1.5">
              {d.topUtms.map((u) => {
                const ref = splitUtmRef(u.value);
                return (
                  <li key={u.value} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate text-foreground">
                      {ref.name ?? ref.id}
                      {ref.name && ref.id && (
                        <span className="ml-1.5 text-xs text-muted-foreground">id {ref.id}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {plural(u.count, "venda", "vendas")}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Panel>

      <SalesFeed sales={sales} />
    </div>
  );
}

function DiagnosisCard({
  icon: Icon,
  tone,
  count,
  title,
  text,
  action,
}: {
  icon: typeof Tags;
  tone: "warning" | "neutral";
  count: number;
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 rounded-lg border border-border bg-surface p-4">
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
          tone === "warning"
            ? "bg-warning/12 text-warning-strong"
            : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 text-sm">
        <p className="flex items-center gap-2 font-medium text-foreground">
          {title}
          <Status tone={tone}>{fmt.int(count)}</Status>
        </p>
        <p className="mt-1 text-muted-foreground">{text}</p>
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}

function TrialsView({ trials }: { trials: ResultSale[] }) {
  const converted = trials.filter((s) => s.trial_converted_at).length;
  if (trials.length === 0) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="Nenhum teste iniciado no período"
        description="Assinaturas com período de teste aparecem aqui assim que começam, já ligadas ao anúncio."
      />
    );
  }
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <MetricCard emphasis label="Testes iniciados" value={fmt.int(trials.length)} />
        <MetricCard label="Pagaram" value={fmt.int(converted)} hint="primeira cobrança aprovada" />
        <MetricCard label="Conversão" value={fmt.pct(converted / trials.length)} />
        <MetricCard label="Ainda em teste" value={fmt.int(trials.length - converted)} />
      </div>
      <SalesFeed sales={trials} />
    </div>
  );
}
