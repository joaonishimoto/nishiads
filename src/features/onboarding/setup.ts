import { useQuery } from "@tanstack/react-query";
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
        supabase.from("ad_accounts").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("is_tracked", true),
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

export type SetupStep = { label: string; hint: string; done: boolean; to: string };

/**
 * Primeiros passos do workspace. `complete` só fica true depois que tudo carregou e não
 * falta nenhum passo: aí a Visão geral sai do menu e o início do app vira o Dashboard.
 */
export function useSetupSteps(): { steps: SetupStep[]; pending: number; loaded: boolean; complete: boolean } {
  const { workspace } = useWorkspace();
  const user = useUser();
  const base = `/w/${workspace.id}`;
  const integrations = useIntegrations(workspace.id);
  const devices = usePushDevices(workspace.id, user.id);
  const counts = useSetupCounts(workspace.id);

  const checkoutReady = (integrations.data ?? []).some((i) => i.active && i.has_secret);
  const checkoutReceiving = (integrations.data ?? []).some((i) => i.active && i.has_secret && i.last_event_at);

  const steps: SetupStep[] = [
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
      hint: "",
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
  const loaded = integrations.isSuccess && devices.isSuccess && counts.isSuccess;
  return { steps, pending, loaded, complete: loaded && pending === 0 };
}
