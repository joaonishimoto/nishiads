import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { AlertTriangle, ChartNoAxesCombined, Coins, Plug, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadError, PageHeader, PageSkeleton, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { isSyncing, metaErrorMessage, useSyncNow } from "@/features/meta/api";
import { useSalesRealtime } from "@/features/sales/api";
import { FilterBar, useResultFilters } from "@/features/results/filters";
import { useResults } from "@/features/results/use-results";
import { change, type NodeMetrics } from "@/features/results/metrics";
import {
  fmt,
  MetricCard,
  RoasTargetButton,
  SpendRevenueChart,
  useRoasTarget,
} from "@/features/results/components";
import { CampaignTree } from "@/features/results/campaign-tree";
import { SaleLine, timeAgo, useFreshIds } from "@/features/results/recent-sales";
import { ProductCostsDialog } from "@/features/results/product-costs";
import { formatMoney } from "@/lib/format";

export function CampaignsPage() {
  const { workspace, canManage } = useWorkspace();
  const base = `/w/${workspace.id}`;
  const filters = useResultFilters();
  const results = useResults(filters, { tree: true });
  const sync = useSyncNow(workspace.id);
  const [target, setTarget] = useRoasTarget(workspace.id);
  const [costsOpen, setCostsOpen] = useState(false);
  useSalesRealtime(workspace.id);

  const syncing = results.tracked.some(isSyncing);
  const header = (
    <PageHeader
      title="Campanhas"
      subtitle={
        results.lastSync
          ? `ROAS, CPA e lucro por campanha, conjunto e anúncio. Meta sincronizada ${timeAgo(results.lastSync, workspace.timezone)}.`
          : "ROAS, CPA e lucro por campanha, conjunto e anúncio."
      }
      actions={
        <>
          <Button variant="outline" onClick={() => setCostsOpen(true)}>
            <Coins />
            Custos
          </Button>
          {canManage && results.metaConnected && (
            <Button
              variant="outline"
              loading={sync.isPending || syncing}
              loadingText="Sincronizando…"
              onClick={() =>
                sync.mutate(undefined, {
                  onSuccess: () =>
                    toast.success("Sincronização iniciada. Os números atualizam sozinhos."),
                  onError: (e) => toast.error(metaErrorMessage(e)),
                })
              }
            >
              <RefreshCw />
              Sincronizar
            </Button>
          )}
        </>
      }
    />
  );

  if (results.isPending && !results.computed) return <PageSkeleton variant="table" />;

  const c = results.computed;
  const t = c?.totals;
  const p = c?.previous;
  const cur = workspace.currency;
  const tree = c?.tree ?? [];
  // Total da tabela = KPIs do topo (inclui a linha de vendas sem campanha).
  const treeTotals: NodeMetrics | null = t
    ? {
        spendCents: t.spendCents,
        impressions: t.impressions,
        linkClicks: t.linkClicks,
        sales: t.approvedCount,
        revenueCents: t.revenueCents,
        feesCents: t.feesCents,
        costCents: t.costCents,
      }
    : null;
  const withoutCampaign = (c?.sales ?? []).filter(
    (s) => s.status === "approved" && s.currency === cur && !s.campaign_id,
  );
  const latest = (c?.sales ?? []).filter((s) => s.status === "approved").slice(0, 5);
  // Hoje: a Meta só tem o gasto do dia inteiro de ontem, então gasto e derivados ficam sem comparação.
  const spendChange = (a: number | null, b: number | null) =>
    filters.partialComparison ? null : change(a, b);
  const noCosts =
    results.products.length > 0 &&
    results.products.every((x) => !x.cost_cents && !x.fee_percent_bps && !x.fee_fixed_cents);

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
          Não foi possível carregar parte dos dados. Os números abaixo podem estar incompletos.
        </LoadError>
      )}

      {!results.metaConnected && (
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
                  Por enquanto, mostramos só o que veio das vendas. Com a conta conectada, cada
                  campanha ganha gasto, CPA e lucro.
                </p>
              </div>
            </div>
            <Button asChild className="shrink-0">
              <Link to={`${base}/integracoes`}>Conectar Meta Ads</Link>
            </Button>
          </div>
        </Panel>
      )}

      {t && (
        <div
          className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4"
          aria-busy={results.isPending}
        >
          <MetricCard
            emphasis
            label="Faturamento"
            value={formatMoney(t.revenueCents, cur)}
            delta={change(t.revenueCents, p?.revenueCents ?? null)}
            hint={filters.comparisonLabel}
          />
          <MetricCard
            label="Gasto"
            value={results.metaConnected ? formatMoney(t.spendCents, cur) : "—"}
            delta={results.metaConnected ? spendChange(t.spendCents, p?.spendCents ?? null) : null}
            invert
            hint={
              filters.productId
                ? "de todas as campanhas"
                : results.metaConnected
                  ? filters.comparisonLabel
                  : "conecte a Meta"
            }
            info={
              filters.productId
                ? "A Meta não separa gasto por produto: o gasto é o das campanhas filtradas."
                : undefined
            }
          />
          <MetricCard
            label="Lucro"
            value={formatMoney(t.profitCents, cur)}
            tone={t.profitCents < 0 ? "danger" : t.profitCents > 0 ? "success" : undefined}
            delta={spendChange(t.profitCents, p?.profitCents ?? null)}
            hint={
              noCosts ? (
                <button
                  type="button"
                  className="underline-offset-2 hover:text-primary hover:underline"
                  onClick={() => setCostsOpen(true)}
                >
                  informe os custos
                </button>
              ) : (
                filters.comparisonLabel
              )
            }
            info="Faturamento − taxas do checkout − custo dos produtos − gasto em anúncios."
          />
          <MetricCard
            label="ROAS"
            value={fmt.roas(t.roas)}
            delta={spendChange(t.roas, p?.roas ?? null)}
            hint={t.roas === null ? "sem gasto no período" : `meta ${fmt.roas(target)}`}
            info="Faturamento dividido pelo gasto. Inclui vendas sem origem identificada."
          />
          <MetricCard
            label="CPA"
            value={fmt.money(t.cpaCents, cur)}
            delta={spendChange(t.cpaCents, p?.cpaCents ?? null)}
            invert
            hint="custo por venda"
          />
          <MetricCard
            label="Vendas"
            value={fmt.int(t.approvedCount)}
            delta={change(t.approvedCount, p?.approvedCount ?? null)}
            hint={filters.comparisonLabel}
          />
          <MetricCard
            label="Ticket médio"
            value={fmt.money(t.ticketCents, cur)}
            delta={change(t.ticketCents, p?.ticketCents ?? null)}
            hint={filters.comparisonLabel}
          />
          <MetricCard
            label="Vendas atribuídas"
            value={fmt.pct(t.matchedShare)}
            hint={
              t.unmatchedApprovedCount > 0 ? (
                <Link
                  to={`${base}/vendas?visao=sem-origem`}
                  className="underline-offset-2 hover:text-primary hover:underline"
                >
                  {t.unmatchedApprovedCount === 1
                    ? "1 sem origem"
                    : `${fmt.int(t.unmatchedApprovedCount)} sem origem`}
                </Link>
              ) : t.approvedCount ? (
                "ligadas a um anúncio"
              ) : (
                "sem vendas no período"
              )
            }
          />
        </div>
      )}

      {t?.otherCurrencySpend && (
        <p className="flex items-start gap-2 text-xs text-warning-strong">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          Há conta de anúncio em outra moeda. O gasto dela fica fora dos totais em {cur}.
        </p>
      )}

      {c && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Panel
            title={
              c.series.mode === "hour"
                ? "Faturamento por hora"
                : results.metaConnected
                  ? "Gasto × faturamento por dia"
                  : "Faturamento por dia"
            }
            description={
              c.series.mode === "hour"
                ? "A Meta informa o gasto por dia, não por hora."
                : `${formatMoney(t!.revenueCents, cur)} faturados${results.metaConnected ? ` · ${formatMoney(t!.spendCents, cur)} investidos` : ""}`
            }
          >
            <SpendRevenueChart
              points={c.series.points}
              mode={c.series.mode}
              currency={cur}
              showSpend={results.metaConnected}
            />
          </Panel>
          <LatestSales sales={latest} to={`${base}/vendas`} />
        </div>
      )}

      {results.metaConnected ? (
        <Panel
          title="Por campanha"
          description="Campanha › Conjunto › Anúncio. Abra uma linha para descer de nível."
          action={<RoasTargetButton target={target} onChange={setTarget} />}
        >
          {tree.length === 0 ? (
            <div className="p-4">
              <EmptyState
                compact
                icon={ChartNoAxesCombined}
                title={syncing ? "Importando campanhas…" : "Nenhuma campanha com gasto no período"}
                description={
                  syncing
                    ? "A primeira importação traz os últimos 30 dias e leva alguns minutos."
                    : "Troque o período ou confira se a conta certa está sendo acompanhada em Integrações."
                }
              />
            </div>
          ) : (
            treeTotals && (
              <CampaignTree
                nodes={tree}
                totals={treeTotals}
                currency={cur}
                target={target}
                unattributed={{
                  sales: withoutCampaign.length,
                  revenueCents: withoutCampaign.reduce((n, s) => n + s.gross_amount_cents, 0),
                  to: `${base}/vendas?visao=sem-origem`,
                }}
              />
            )
          )}
        </Panel>
      ) : null}

      <ProductCostsDialog
        open={costsOpen}
        onOpenChange={setCostsOpen}
        products={results.products}
      />
    </div>
  );
}

function LatestSales({
  sales,
  to,
}: {
  sales: Parameters<typeof SaleLine>[0]["sale"][];
  to: string;
}) {
  const fresh = useFreshIds(sales.map((s) => s.id));
  return (
    <Panel
      title="Últimas vendas"
      description="Aparecem aqui na hora em que são aprovadas."
      action={
        <Link to={to} className="shrink-0 text-xs font-medium text-primary hover:underline">
          Ver todas
        </Link>
      }
    >
      {sales.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          Nenhuma venda aprovada no período.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {sales.map((s) => (
            <SaleLine key={s.id} sale={s} fresh={fresh.has(s.id)} compact />
          ))}
        </ul>
      )}
    </Panel>
  );
}
