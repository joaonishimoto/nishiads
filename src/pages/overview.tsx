import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Panel } from "@/components/app/ui";
import { useUser } from "@/features/auth/auth-provider";
import { useIntegrations } from "@/features/integrations/api";
import { usePushDevices } from "@/features/notifications/api";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { supabase } from "@/lib/supabase";

/** Contas de anúncio conectadas e vendas que chegaram com UTMs: o resto vem dos hooks das outras telas. */
function useSetupCounts(workspaceId: string) {
  return useQuery({
    queryKey: ["overview", workspaceId, "setup"],
    queryFn: async () => {
      const [accounts, salesWithUtm] = await Promise.all([
        supabase.from("ad_accounts").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),
        supabase
          .from("sales")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .neq("attribution_status", "unattributed"),
      ]);
      if (accounts.error) throw accounts.error;
      if (salesWithUtm.error) throw salesWithUtm.error;
      return { adAccounts: accounts.count ?? 0, salesWithUtm: salesWithUtm.count ?? 0 };
    },
  });
}

type Step = { label: string; hint: string; done: boolean; to: string };

export function OverviewPage() {
  const { workspace, canManage } = useWorkspace();
  const user = useUser();
  const base = `/w/${workspace.id}`;
  const integrations = useIntegrations(workspace.id);
  const devices = usePushDevices(workspace.id, user.id);
  const counts = useSetupCounts(workspace.id);

  const checkoutReady = (integrations.data ?? []).some((i) => i.active && i.has_secret);
  const checkoutReceiving = (integrations.data ?? []).some((i) => i.active && i.has_secret && i.last_event_at);

  const steps: Step[] = [
    { label: "Workspace criado", hint: "", done: true, to: `${base}/ajustes` },
    {
      label: "Conectar o checkout (webhook de vendas)",
      hint: checkoutReady && !checkoutReceiving ? "Conectado. Aguardando o primeiro evento." : "",
      done: checkoutReady,
      to: `${base}/integracoes`,
    },
    {
      label: "Ativar notificações de venda no celular",
      hint: "",
      done: (devices.data ?? []).some((d) => d.active),
      to: `${base}/ajustes/notificacoes`,
    },
    {
      label: "Conectar a conta de anúncios da Meta",
      hint: (counts.data?.adAccounts ?? 0) > 0 ? "" : "Disponível na próxima atualização.",
      done: (counts.data?.adAccounts ?? 0) > 0,
      to: `${base}/campanhas`,
    },
    {
      label: "Configurar UTMs nos anúncios e no checkout",
      hint: (counts.data?.salesWithUtm ?? 0) > 0 ? "" : "Conclui quando a primeira venda chegar com UTMs.",
      done: (counts.data?.salesWithUtm ?? 0) > 0,
      to: `${base}/ajuda`,
    },
  ];
  const pending = steps.filter((s) => !s.done).length;

  return (
    <div className="space-y-6">
      <PageHeader title="Visão geral" subtitle={`Resultados de ${workspace.name}.`} />
      <Panel
        title="Primeiros passos"
        description={
          pending === 0
            ? "Tudo conectado. O dashboard com ROAS, CPA e lucro chega na próxima atualização."
            : "O dashboard com ROAS, CPA e lucro aparece aqui conforme você conecta as fontes."
        }
      >
        <ul className="divide-y divide-border">
          {steps.map((step) => (
            <li key={step.label}>
              <Link
                to={step.to}
                className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-surface-hover"
              >
                {step.done ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-label="Concluído" />
                ) : (
                  <Circle className="h-5 w-5 shrink-0 text-muted-foreground" aria-label="Pendente" />
                )}
                <span className="min-w-0 flex-1">
                  <span className={step.done ? "text-muted-foreground line-through" : "text-foreground"}>
                    {step.label}
                  </span>
                  {step.hint && <span className="block text-xs text-muted-foreground">{step.hint}</span>}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
        {canManage && (
          <div className="border-t border-border p-4">
            <Button variant="outline" asChild>
              <Link to={`${base}/ajustes/membros`}>Convidar a equipe</Link>
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}
