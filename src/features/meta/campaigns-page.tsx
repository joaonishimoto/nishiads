import { useMemo } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChartNoAxesCombined } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadError, PageHeader, PageSkeleton, Panel, Status } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { useAdAccounts } from "@/features/meta/api";
import { supabase } from "@/lib/supabase";
import { formatDateTime, formatMoney } from "@/lib/format";
import { addDays, ymdInZone } from "@/lib/period";

const DAYS = 7;

type CampaignTotals = {
  id: string;
  name: string;
  effective_status: string | null;
  spend_cents: number;
  impressions: number;
  link_clicks: number;
  currency: string;
};

/** Gasto dos últimos 7 dias por campanha (prévia; o dashboard completo vem na etapa 5). */
function useCampaignTotals(workspaceId: string, timezone: string) {
  return useQuery({
    queryKey: ["meta", workspaceId, "campaign-totals", DAYS],
    queryFn: async (): Promise<CampaignTotals[]> => {
      const since = addDays(ymdInZone(new Date(), timezone), -(DAYS - 1));
      const [campaigns, insights] = await Promise.all([
        supabase.from("campaigns").select("id, name, effective_status").eq("workspace_id", workspaceId),
        supabase
          .from("ad_insights_daily")
          .select("spend_cents, impressions, link_clicks, currency, ad:ads(campaign_id)")
          .eq("workspace_id", workspaceId)
          .gte("date", since)
          .limit(10000),
      ]);
      if (campaigns.error) throw campaigns.error;
      if (insights.error) throw insights.error;
      const totals = new Map<string, CampaignTotals>(
        (campaigns.data ?? []).map((c) => [
          c.id,
          { ...c, spend_cents: 0, impressions: 0, link_clicks: 0, currency: "BRL" },
        ]),
      );
      type Row = { spend_cents: number; impressions: number; link_clicks: number; currency: string; ad: { campaign_id: string } | null };
      for (const row of (insights.data ?? []) as unknown as Row[]) {
        const t = row.ad && totals.get(row.ad.campaign_id);
        if (!t) continue;
        t.spend_cents += row.spend_cents;
        t.impressions += row.impressions;
        t.link_clicks += row.link_clicks;
        t.currency = row.currency;
      }
      return [...totals.values()]
        .filter((t) => t.spend_cents > 0 || t.effective_status === "ACTIVE")
        .sort((a, b) => b.spend_cents - a.spend_cents);
    },
  });
}

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Ativa",
  PAUSED: "Pausada",
  ARCHIVED: "Arquivada",
  DELETED: "Excluída",
  IN_PROCESS: "Em processamento",
  WITH_ISSUES: "Com problemas",
};

export function CampaignsPage() {
  const { workspace } = useWorkspace();
  const accounts = useAdAccounts(workspace.id);
  const totals = useCampaignTotals(workspace.id, workspace.timezone);
  const tracked = accounts.data?.filter((a) => a.is_tracked) ?? [];
  const lastSync = tracked
    .map((a) => a.last_synced_at)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1);

  const totalSpend = useMemo(() => (totals.data ?? []).reduce((sum, t) => sum + t.spend_cents, 0), [totals.data]);

  const header = (
    <PageHeader
      title="Campanhas"
      subtitle={
        lastSync
          ? `Dados da Meta Ads · última sincronização ${formatDateTime(lastSync, workspace.timezone)}`
          : "ROAS, CPA e lucro por campanha, conjunto e criativo."
      }
    />
  );

  if (accounts.isPending || totals.isPending) return <PageSkeleton rows={5} />;
  if (accounts.isError || totals.isError) {
    return (
      <div className="space-y-6">
        {header}
        <LoadError onRetry={() => (accounts.refetch(), totals.refetch())} retrying={accounts.isFetching || totals.isFetching}>
          Não foi possível carregar as campanhas.
        </LoadError>
      </div>
    );
  }
  if (tracked.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={ChartNoAxesCombined}
          title="Conecte a Meta Ads"
          description="Conecte sua conta e escolha quais contas de anúncio acompanhar. As campanhas aparecem aqui depois da primeira sincronização."
          action={
            <Button asChild>
              <Link to={`/w/${workspace.id}/integracoes`}>Ir para Integrações</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      <Panel
        title={`Últimos ${DAYS} dias`}
        description={`${formatMoney(totalSpend)} investidos. ROAS, CPA e lucro por criativo chegam na próxima etapa.`}
      >
        {totals.data.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            Nenhuma campanha com gasto nos últimos {DAYS} dias. Se você acabou de escolher a conta, a importação leva
            alguns minutos.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {totals.data.map((c) => {
              const ctr = c.impressions ? (c.link_clicks / c.impressions) * 100 : 0;
              return (
                <li key={c.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{c.name}</p>
                    <div className="mt-1">
                      <Status tone={c.effective_status === "ACTIVE" ? "success" : "neutral"}>
                        {STATUS_LABELS[c.effective_status ?? ""] ?? c.effective_status ?? "—"}
                      </Status>
                    </div>
                  </div>
                  <dl className="grid shrink-0 grid-cols-3 gap-4 text-right text-sm tabular-nums sm:w-96">
                    <div>
                      <dt className="text-xs text-muted-foreground">Gasto</dt>
                      <dd className="font-medium text-foreground">{formatMoney(c.spend_cents, c.currency)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Cliques no link</dt>
                      <dd className="text-foreground">{c.link_clicks.toLocaleString("pt-BR")}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">CTR</dt>
                      <dd className="text-foreground">{ctr.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%</dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
