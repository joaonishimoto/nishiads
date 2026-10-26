import { Fragment, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  CircleDashed,
  FlaskConical,
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
import { FilterBar, useResultFilters } from "@/features/results/filters";
import { useResults } from "@/features/results/use-results";
import {
  change,
  diagnoseUnmatched,
  saleInstant,
  topOrigins,
  type ResultSale,
  type Totals,
} from "@/features/results/metrics";
import { addDays, ymdInZone } from "@/lib/period";
import {
  fmt,
  LiveBadge,
  MetricCard,
  SpendRevenueChart,
  Thumb,
} from "@/features/results/components";
import { SaleLine, useFreshIds } from "@/features/results/recent-sales";
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

export function SalesPage() {
  const { workspace } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const view: View =
    params.get("visao") === "sem-origem"
      ? "unmatched"
      : params.get("visao") === "testes"
        ? "trials"
        : "all";
  const filters = useResultFilters();
  const results = useResults(filters);
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
      title="Vendas"
      subtitle="Cada venda com a campanha, o conjunto e o criativo de origem."
      actions={<LiveBadge />}
    />
  );
  if (results.isPending && !results.computed) return <PageSkeleton variant="table" />;
  if (!results.computed) {
    return (
      <div className="space-y-5">
        {header}
        <LoadError onRetry={results.retry} retrying={results.isFetching}>
          Não foi possível carregar as vendas.
        </LoadError>
      </div>
    );
  }

  const { sales, totals, previous, series } = results.computed;
  const unmatched = sales.filter(
    (s) => s.attribution_status !== "matched" && s.status !== "trialing",
  );
  const trials = sales.filter((s) => s.status === "trialing");
  const tabs: { key: View; label: string; count?: number }[] = [
    { key: "all", label: "Todas" },
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
        <AllView
          sales={sales}
          totals={totals}
          previous={previous}
          series={series}
          comparison={filters.comparisonLabel}
        />
      )}
      {view === "unmatched" && <UnmatchedView sales={unmatched} />}
      {view === "trials" && <TrialsView trials={trials} />}
    </div>
  );
}

function AllView({
  sales,
  totals: t,
  previous: p,
  series,
  comparison,
}: {
  sales: ResultSale[];
  totals: Totals;
  previous: Totals | null;
  series: NonNullable<ReturnType<typeof useResults>["computed"]>["series"];
  comparison: string;
}) {
  const { workspace } = useWorkspace();
  const base = `/w/${workspace.id}`;
  const cur = workspace.currency;
  const [params, setParams] = useSearchParams();
  const status = (STATUS_FILTERS.find((f) => f.key === params.get("status"))?.key ??
    "all") as StatusFilter;
  const origins = useMemo(() => topOrigins(sales, cur), [sales, cur]);
  const match = STATUS_FILTERS.find((f) => f.key === status)!.match;
  const visible = sales.filter((s) => match(s.status));
  const counts = Object.fromEntries(
    STATUS_FILTERS.map((f) => [f.key, sales.filter((s) => f.match(s.status)).length]),
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <MetricCard
          emphasis
          label="Faturamento aprovado"
          value={formatMoney(t.revenueCents, cur)}
          delta={change(t.revenueCents, p?.revenueCents ?? null)}
          hint={comparison}
        />
        <MetricCard
          label="Vendas aprovadas"
          value={fmt.int(t.approvedCount)}
          delta={change(t.approvedCount, p?.approvedCount ?? null)}
          hint={comparison}
        />
        <MetricCard
          label="Ticket médio"
          value={fmt.money(t.ticketCents, cur)}
          delta={change(t.ticketCents, p?.ticketCents ?? null)}
          hint={comparison}
        />
        <MetricCard
          label="Com origem"
          value={fmt.pct(t.matchedShare)}
          hint={
            t.approvedCount
              ? `${formatMoney(t.matchedRevenueCents, cur)} atribuídos`
              : "sem vendas no período"
          }
          info="Vendas aprovadas ligadas a campanha, conjunto e criativo."
        />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm sm:flex sm:flex-wrap sm:gap-x-8">
        <QuickStat
          label="Pendentes"
          value={
            t.pendingCount
              ? `${fmt.int(t.pendingCount)} · ${formatMoney(t.pendingCents, cur)}`
              : "0"
          }
        />
        <QuickStat
          label="Reembolsos e chargebacks"
          value={
            t.refundCount ? `${fmt.int(t.refundCount)} · ${formatMoney(t.refundCents, cur)}` : "0"
          }
          tone={t.refundCount ? "danger" : undefined}
        />
        {t.trialCount > 0 && (
          <QuickStat
            label="Testes iniciados"
            value={`${fmt.int(t.trialCount)} · ${fmt.pct(t.trialConvertedCount / t.trialCount)} pagaram`}
          />
        )}
        <QuickStat
          label="Taxa de reembolso"
          value={
            t.approvedCount + t.refundCount
              ? fmt.pct(t.refundCount / (t.approvedCount + t.refundCount), 1)
              : "—"
          }
        />
      </dl>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel
          title={series.mode === "hour" ? "Faturamento por hora" : "Faturamento por dia"}
          description={`${plural(t.approvedCount, "venda aprovada", "vendas aprovadas")} no período`}
        >
          <SpendRevenueChart
            points={series.points}
            mode={series.mode}
            currency={cur}
            showSpend={false}
          />
        </Panel>
        <Panel
          title="Criativos que mais venderam"
          action={
            <Link
              to={`${base}/campanhas`}
              className="shrink-0 text-xs font-medium text-primary hover:underline"
            >
              Ver ROAS
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
      </div>

      <SalesFeed
        sales={visible}
        chips={
          <div className="flex gap-1.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]" role="group" aria-label="Status">
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
