import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Receipt, RefreshCw, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, LoadError, PageHeader, PageSkeleton, Panel, Status } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import {
  useReattributeSales,
  useSalesList,
  useSalesRealtime,
  useSalesSummary,
  type SaleListItem,
  type SalesFilters,
} from "@/features/sales/api";
import { ATTRIBUTION_META, SALE_STATUS_META } from "@/features/sales/meta";
import { AttributionPath } from "@/features/sales/attribution-path";
import { friendlyError } from "@/lib/errors";
import { formatDateTime, formatMoney, plural } from "@/lib/format";
import { PERIOD_LABELS, periodRange, ymdInZone, type PeriodKey } from "@/lib/period";
import { cn } from "@/lib/utils";
import type { SaleStatus } from "@/types/database";

const PERIODS: PeriodKey[] = ["today", "yesterday", "7d", "30d", "custom"];
const STATUSES: (SaleStatus | "all")[] = ["all", "approved", "trialing", "pending", "refunded", "chargeback", "canceled"];

export function SalesPage() {
  const { workspace } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const view = params.get("visao") === "sem-origem" ? "unmatched" : "all";
  const period = (PERIODS.includes(params.get("periodo") as PeriodKey) ? params.get("periodo") : "7d") as PeriodKey;
  const status = (STATUSES.includes(params.get("status") as SaleStatus) ? params.get("status") : "all") as
    | SaleStatus
    | "all";
  const today = ymdInZone(new Date(), workspace.timezone);
  const customFrom = params.get("de") ?? today;
  const customTo = params.get("ate") ?? today;

  const range = useMemo(
    () => periodRange(period, workspace.timezone, new Date(), { from: customFrom, to: customTo }),
    // A data de hoje entra na chave para virar o dia sem recarregar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [period, workspace.timezone, customFrom, customTo, today],
  );
  const filters: SalesFilters = { range, status, attribution: view };

  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  useSalesRealtime(workspace.id);

  return (
    <div className="space-y-5">
      <PageHeader title="Vendas" subtitle="Cada venda com a campanha, o conjunto e o criativo de origem." />

      <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Visão">
        {(
          [
            ["all", "Todas"],
            ["unmatched", "Sem origem"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={view === key}
            onClick={() => setParam("visao", key === "unmatched" ? "sem-origem" : null)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
              view === key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 sm:flex sm:flex-wrap sm:items-end">
        <Select value={period} onValueChange={(v) => setParam("periodo", v === "7d" ? null : v)}>
          <SelectTrigger className="sm:w-48" aria-label="Período">
            <SelectValue placeholder="Selecione…" />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p} value={p}>
                {PERIOD_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setParam("status", v === "all" ? null : v)}>
          <SelectTrigger className="sm:w-44" aria-label="Status">
            <SelectValue placeholder="Selecione…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            {STATUSES.filter((s): s is SaleStatus => s !== "all").map((s) => (
              <SelectItem key={s} value={s}>
                {SALE_STATUS_META[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {period === "custom" && (
          <>
            <Input
              type="date"
              aria-label="De"
              placeholder="De"
              className="sm:w-40"
              value={customFrom}
              max={today}
              onChange={(e) => setParam("de", e.target.value || null)}
            />
            <Input
              type="date"
              aria-label="Até"
              placeholder="Até"
              className="sm:w-40"
              value={customTo}
              min={customFrom}
              max={today}
              onChange={(e) => setParam("ate", e.target.value || null)}
            />
          </>
        )}
      </div>

      {view === "all" ? <SummaryRow range={range} /> : <UnmatchedExplainer />}

      <SalesList filters={filters} />
    </div>
  );
}

function SummaryRow({ range }: { range: SalesFilters["range"] }) {
  const { workspace } = useWorkspace();
  const summary = useSalesSummary(workspace.id, range, workspace.currency);
  if (summary.isError) {
    return (
      <LoadError onRetry={() => summary.refetch()} retrying={summary.isFetching}>
        Não foi possível calcular os totais do período.
      </LoadError>
    );
  }
  const s = summary.data;
  const items = [
    { label: "Faturamento aprovado", value: s ? formatMoney(s.approvedRevenueCents, workspace.currency) : "…" },
    { label: "Vendas aprovadas", value: s ? s.approvedCount.toLocaleString("pt-BR") : "…" },
    { label: "Reembolsos e chargebacks", value: s ? s.refundCount.toLocaleString("pt-BR") : "…" },
    {
      label: "Vendas com origem",
      value: s ? (s.matchedShare === null ? "—" : `${Math.round(s.matchedShare * 100)}%`) : "…",
    },
  ];
  // Testes só aparecem para quem vende assinatura com período de teste.
  if (s && s.trialCount > 0) {
    items.push({
      label: "Testes iniciados",
      value: `${s.trialCount.toLocaleString("pt-BR")} · ${Math.round((s.trialConvertedCount / s.trialCount) * 100)}% pagaram`,
    });
  }
  return (
    <div
      className={cn("grid grid-cols-2 gap-3", items.length > 4 ? "xl:grid-cols-5" : "xl:grid-cols-4")}
      aria-busy={summary.isPending}
    >
      {items.map((item) => (
        <div key={item.label} className="min-w-0 rounded-lg border border-border bg-surface p-3 sm:p-4">
          <p className="truncate text-xs font-medium text-muted-foreground">{item.label}</p>
          <p className="mt-1.5 text-lg font-semibold tracking-tight tabular-nums text-foreground sm:text-2xl">
            {item.value}
          </p>
        </div>
      ))}
    </div>
  );
}

function UnmatchedExplainer() {
  const { workspace, canManage } = useWorkspace();
  const reattribute = useReattributeSales(workspace.id);
  return (
    <Panel>
      <div className="grid gap-3 p-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="space-y-1.5 text-muted-foreground">
          <p>
            <Status tone={ATTRIBUTION_META.partial.tone}>{ATTRIBUTION_META.partial.label}</Status>{" "}
            {ATTRIBUTION_META.partial.description} Conecte ou sincronize a conta da Meta para completar.
          </p>
          <p>
            <Status tone={ATTRIBUTION_META.unattributed.tone}>{ATTRIBUTION_META.unattributed.label}</Status>{" "}
            {ATTRIBUTION_META.unattributed.description} Confira os parâmetros de URL dos anúncios e o script da página.
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
                    matched ? `${plural(matched, "venda atribuída", "vendas atribuídas")} agora.` : "Nenhuma venda nova atribuída.",
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
    </Panel>
  );
}

function SalesList({ filters }: { filters: SalesFilters }) {
  const { workspace } = useWorkspace();
  const list = useSalesList(workspace.id, filters);

  if (list.isPending) return <PageSkeleton variant="table" />;
  if (list.isError) {
    return (
      <LoadError onRetry={() => list.refetch()} retrying={list.isFetching}>
        Não foi possível carregar as vendas.
      </LoadError>
    );
  }

  const sales = list.data.pages.flat();
  if (sales.length === 0) {
    return filters.attribution === "unmatched" ? (
      <EmptyState
        icon={SearchX}
        title="Nenhuma venda sem origem"
        description="Todas as vendas deste período foram ligadas a um criativo."
      />
    ) : (
      <EmptyState
        icon={Receipt}
        title="Nenhuma venda no período"
        description="As vendas aparecem aqui assim que o checkout enviar o webhook."
        action={
          <Button variant="outline" asChild>
            <Link to={`/w/${workspace.id}/integracoes`}>Conectar checkout</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <Panel>
        <ul className="divide-y divide-border">
          {sales.map((sale) => (
            <SaleRow key={sale.id} sale={sale} />
          ))}
        </ul>
      </Panel>
      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            loading={list.isFetchingNextPage}
            loadingText="Carregando…"
            onClick={() => list.fetchNextPage()}
          >
            Carregar mais
          </Button>
        </div>
      )}
    </div>
  );
}

function SaleRow({ sale }: { sale: SaleListItem }) {
  const { workspace } = useWorkspace();
  const status = SALE_STATUS_META[sale.status];
  const when = sale.paid_at ?? sale.created_at;
  return (
    <li>
      <Link
        to={`/w/${workspace.id}/vendas/${sale.id}`}
        className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-surface-hover"
      >
        <span className="truncate text-sm font-medium text-foreground">{sale.product_name ?? "Produto sem nome"}</span>
        <span
          className={cn(
            "text-right text-sm font-semibold tabular-nums",
            sale.status === "approved" && "text-foreground",
            (sale.status === "pending" || sale.status === "trialing") && "text-muted-foreground",
            ["refunded", "chargeback", "canceled"].includes(sale.status) && "text-muted-foreground line-through",
          )}
        >
          {sale.status === "trialing"
            ? sale.trial_converted_at
              ? "Pagou"
              : "Em teste"
            : formatMoney(sale.gross_amount_cents, sale.currency)}
        </span>
        <span className="min-w-0 text-xs">
          <AttributionPath
            sale={sale}
            className={
              sale.attribution_status === "matched"
                ? "inline-flex min-w-0 flex-wrap items-center gap-x-1 text-foreground"
                : "inline-flex min-w-0 flex-wrap items-center gap-x-1 text-muted-foreground"
            }
          />
        </span>
        <span className="flex items-center justify-end gap-1.5">
          <Status tone={status.tone}>{status.label}</Status>
        </span>
        <span className="col-span-2 text-xs text-muted-foreground">
          {formatDateTime(when, workspace.timezone)}
          {sale.attribution_status !== "matched" && ` · ${ATTRIBUTION_META[sale.attribution_status].label}`}
        </span>
      </Link>
    </li>
  );
}
