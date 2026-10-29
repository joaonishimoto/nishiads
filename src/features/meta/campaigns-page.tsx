import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChartNoAxesCombined,
  Coins,
  Gauge,
  Images,
  Plug,
  RefreshCw,
  Rows3,
  ToggleRight,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadError, PageHeader, PageSkeleton, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { isSyncing, metaErrorMessage, useMetaConnections, useSyncNow } from "@/features/meta/api";
import { WRITE_SCOPE } from "@/features/meta/actions";
import { ActionHistoryButton, MetaControlsProvider, useTouchedIds } from "@/features/meta/controls";
import { useSalesRealtime } from "@/features/sales/api";
import { FilterBar, useResultFilters } from "@/features/results/filters";
import { useResults } from "@/features/results/use-results";
import type { NodeMetrics } from "@/features/results/metrics";
import { fmt, RoasTargetButton, useRoasTarget } from "@/features/results/components";
import { CAMPAIGNS_VIEW, CampaignTree } from "@/features/results/campaign-tree";
import { ViewPicker, useViewItems } from "@/features/views/view-picker";
import { timeAgo } from "@/features/results/recent-sales";
import { ProductCostsDialog } from "@/features/results/product-costs";
import { CreativeGrid, flattenAds } from "@/features/results/campaign-visuals";
import { cn } from "@/lib/utils";

// Só campanhas e as métricas de cada uma; os KPIs gerais (lucro, ROAS do negócio) ficam no Dashboard.
type Tab = "campanhas" | "criativos";
const TABS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: "campanhas", label: "Campanhas", icon: Rows3 },
  { key: "criativos", label: "Criativos", icon: Images },
];

export function CampaignsPage() {
  const { workspace } = useWorkspace();
  return (
    <MetaControlsProvider currency={workspace.currency}>
      <CampaignsContent />
    </MetaControlsProvider>
  );
}

function CampaignsContent() {
  const { workspace, canManage } = useWorkspace();
  const base = `/w/${workspace.id}`;
  const filters = useResultFilters();
  // Linhas alteradas pelo app ficam na tabela mesmo sem gasto (ex.: acabou de pausar).
  const results = useResults(filters, { tree: true, keep: useTouchedIds() });
  const connections = useMetaConnections(workspace.id);
  const needsWriteScope =
    canManage &&
    results.metaConnected &&
    (connections.data ?? []).some(
      (cn) => cn.status === "active" && !cn.scopes.includes(WRITE_SCOPE),
    );
  const sync = useSyncNow(workspace.id);
  const [target, setTarget] = useRoasTarget(workspace.id);
  const [costsOpen, setCostsOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.some((x) => x.key === params.get("aba"))
    ? (params.get("aba") as Tab)
    : "campanhas";
  const setTab = (next: Tab) =>
    setParams(
      (prev) => {
        const q = new URLSearchParams(prev);
        if (next === "campanhas") q.delete("aba");
        else q.set("aba", next);
        return q;
      },
      { replace: true },
    );
  useSalesRealtime(workspace.id);
  const view = useViewItems("campaigns", CAMPAIGNS_VIEW);

  const syncing = results.tracked.some(isSyncing);
  const header = (
    <PageHeader
      title="Campanhas"
      subtitle={
        results.lastSync
          ? `Métricas de cada campanha, conjunto e anúncio. Meta sincronizada ${timeAgo(results.lastSync, workspace.timezone)}.`
          : "Métricas de cada campanha, conjunto e anúncio."
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
  const cur = workspace.currency;
  const tree = c?.tree ?? [];
  // Total da tabela = KPIs do Dashboard (inclui a linha de vendas sem campanha).
  const treeTotals: NodeMetrics | null = t
    ? {
        spendCents: t.spendCents,
        impressions: t.impressions,
        linkClicks: t.linkClicks,
        registrations: t.registrations,
        trials: t.metaTrials,
        allClicks: t.allClicks,
        actions: t.actions,
        sales: t.approvedCount,
        revenueCents: t.revenueCents,
        feesCents: t.feesCents,
        costCents: t.costCents,
      }
    : null;
  const withoutCampaign = (c?.sales ?? []).filter(
    (s) => s.status === "approved" && s.currency === cur && !s.campaign_id,
  );
  const creatives = flattenAds(tree);
  const noCampaigns = (
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
  );

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
                  Com a conta conectada, cada campanha, conjunto e anúncio aparece aqui com gasto,
                  CPA e lucro, e dá para pausar, ativar e mudar orçamentos.
                </p>
              </div>
            </div>
            <Button asChild className="shrink-0">
              <Link to={`${base}/integracoes`}>Conectar Meta Ads</Link>
            </Button>
          </div>
        </Panel>
      )}

      {t?.otherCurrencySpend && (
        <p className="flex items-start gap-2 text-xs text-warning-strong">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          Há conta de anúncio em outra moeda. O gasto dela fica fora dos totais em {cur}.
        </p>
      )}

      {c && results.metaConnected && (
        // Fica presa abaixo do topo ao rolar: a troca de visão está sempre à mão.
        <div className="sticky top-14 z-10 -mx-4 flex items-center justify-between gap-3 border-b border-border bg-background px-4 py-2.5 md:top-16 md:-mx-8 md:px-8">
          <div
            className="grid w-full grid-cols-2 gap-1 rounded-lg border border-border bg-muted p-1 sm:inline-flex sm:w-auto"
            role="tablist"
            aria-label="Visão"
          >
            {TABS.map((tb) => {
              const count =
                tb.key === "campanhas"
                  ? tree.length
                  : tb.key === "criativos"
                    ? creatives.length
                    : undefined;
              return (
                <button
                  key={tb.key}
                  role="tab"
                  aria-selected={tab === tb.key}
                  onClick={() => setTab(tb.key)}
                  className={cn(
                    "inline-flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors sm:px-4",
                    tab === tb.key
                      ? "bg-surface text-primary shadow-sm"
                      : "text-muted-foreground hover:bg-surface/60 hover:text-foreground",
                  )}
                >
                  <tb.icon className="h-4 w-4 shrink-0" aria-hidden />
                  {tb.label}
                  {count !== undefined && count > 0 && (
                    <span className="hidden rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground min-[400px]:inline">
                      {fmt.int(count)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="hidden items-center gap-3 sm:flex">
            <Link
              to={`${base}/dashboard`}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-primary"
            >
              <Gauge className="h-3.5 w-3.5" />
              Métricas gerais no Dashboard
            </Link>
            <RoasTargetButton target={target} onChange={setTarget} />
          </div>
        </div>
      )}

      {needsWriteScope && (
        <Panel>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-primary">
                <ToggleRight className="h-4 w-4" />
              </span>
              <div className="text-sm">
                <p className="font-medium text-foreground">Pause, ative e mude orçamentos daqui</p>
                <p className="mt-0.5 text-muted-foreground">
                  Reconecte a Meta e aceite a permissão de gerenciar anúncios para liberar as chaves
                  da tabela.
                </p>
              </div>
            </div>
            <Button asChild variant="outline" className="shrink-0">
              <Link to={`${base}/integracoes`}>Reconectar a Meta</Link>
            </Button>
          </div>
        </Panel>
      )}

      {c && results.metaConnected && tab === "campanhas" && (
        <Panel
          title="Campanha › Conjunto › Anúncio"
          description="Abra uma linha para ver os conjuntos e os anúncios. Toque no título de uma coluna para ordenar."
          action={
            <span className="sm:hidden">
              <RoasTargetButton target={target} onChange={setTarget} />
            </span>
          }
        >
          {tree.length === 0 ? (
            <div className="p-4">{noCampaigns}</div>
          ) : (
            treeTotals && (
              <CampaignTree
                nodes={tree}
                totals={treeTotals}
                currency={cur}
                target={target}
                columns={view.items}
                toolbar={
                  <>
                    <ViewPicker page="campaigns" catalog={CAMPAIGNS_VIEW} className="h-8" />
                    <ActionHistoryButton currency={cur} />
                  </>
                }
                unattributed={{
                  sales: withoutCampaign.length,
                  revenueCents: withoutCampaign.reduce((n, s) => n + s.gross_amount_cents, 0),
                  to: `${base}/dashboard?visao=sem-origem`,
                }}
              />
            )
          )}
        </Panel>
      )}

      {c && results.metaConnected && tab === "criativos" && (
        <div className="space-y-3">
          <div className="flex justify-end sm:hidden">
            <RoasTargetButton target={target} onChange={setTarget} />
          </div>
          {creatives.length === 0 ? (
            noCampaigns
          ) : (
            <CreativeGrid items={creatives} currency={cur} target={target} />
          )}
        </div>
      )}

      <ProductCostsDialog
        open={costsOpen}
        onOpenChange={setCostsOpen}
        products={results.products}
      />
    </div>
  );
}
