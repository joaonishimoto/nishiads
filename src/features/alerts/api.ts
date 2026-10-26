import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Alert, AlertRule, RuleValues } from "@/features/alerts/rules";

export const alertKeys = {
  all: (workspaceId: string) => ["alerts", workspaceId] as const,
  list: (workspaceId: string) => ["alerts", workspaceId, "list"] as const,
  pending: (workspaceId: string) => ["alerts", workspaceId, "pending"] as const,
  rules: (workspaceId: string) => ["alerts", workspaceId, "rules"] as const,
  campaigns: (workspaceId: string) => ["alerts", workspaceId, "campaigns"] as const,
};

/** Os alertas chegam a cada sincronização (15 min); a tela confere de minuto em minuto. */
const REFRESH_MS = 60_000;

export function useAlerts(workspaceId: string) {
  return useQuery({
    queryKey: alertKeys.list(workspaceId),
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<Alert[]> => {
      const { data, error } = await supabase
        .from("alerts")
        .select("*")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Quantos alertas esperam aprovação (badge do menu). */
export function usePendingAlertsCount(workspaceId: string) {
  return useQuery({
    queryKey: alertKeys.pending(workspaceId),
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from("alerts")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("status", "pending");
      if (error) throw error;
      return count ?? 0;
    },
  });
}

export function useAlertRules(workspaceId: string) {
  return useQuery({
    queryKey: alertKeys.rules(workspaceId),
    queryFn: async (): Promise<AlertRule[]> => {
      const { data, error } = await supabase
        .from("alert_rules")
        .select("*")
        .eq("workspace_id", workspaceId)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export type CampaignOption = { id: string; name: string; ad_account_id: string; effective_status: string | null };

/** Campanhas para o escopo da regra (ativas primeiro). */
export function useCampaignOptions(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: alertKeys.campaigns(workspaceId),
    enabled,
    queryFn: async (): Promise<CampaignOption[]> => {
      const { data, error } = await supabase
        .from("campaigns")
        .select("id, name, ad_account_id, effective_status")
        .eq("workspace_id", workspaceId)
        .order("name")
        .limit(1000);
      if (error) throw error;
      return (data ?? []).sort(
        (a, b) => Number(b.effective_status === "ACTIVE") - Number(a.effective_status === "ACTIVE"),
      );
    },
  });
}

export function useSaveRule(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id: string | null; values: RuleValues }) => {
      const { error } = id
        ? await supabase.from("alert_rules").update(values).eq("id", id).eq("workspace_id", workspaceId)
        : await supabase.from("alert_rules").insert({ ...values, workspace_id: workspaceId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: alertKeys.rules(workspaceId) }),
  });
}

export function useToggleRule(workspaceId: string) {
  const qc = useQueryClient();
  const key = alertKeys.rules(workspaceId);
  return useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase.from("alert_rules").update({ enabled }).eq("id", id).eq("workspace_id", workspaceId);
      if (error) throw error;
    },
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<AlertRule[]>(key);
      if (previous) qc.setQueryData(key, previous.map((r) => (r.id === id ? { ...r, enabled } : r)));
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useDeleteRule(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("alert_rules").delete().eq("id", id).eq("workspace_id", workspaceId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: alertKeys.all(workspaceId) }),
  });
}

export type PreviewMatch = {
  object_id: string;
  object_name: string;
  spend_cents: number;
  sales: number;
  revenue_cents: number;
  roas: number | null;
  cpa_cents: number | null;
};

export function usePreviewRule(workspaceId: string) {
  return useMutation({
    mutationFn: async (values: RuleValues): Promise<PreviewMatch[]> => {
      const { data, error } = await supabase.rpc("preview_alert_rule", {
        p_workspace_id: workspaceId,
        p_condition: values.condition,
        p_level: values.level,
        p_time_window: values.time_window,
        p_threshold_cents: values.threshold_cents,
        p_min_roas: values.min_roas,
        p_min_spend_cents: values.min_spend_cents,
        p_ad_account_id: values.ad_account_id,
        p_campaign_id: values.campaign_id,
      });
      if (error) throw error;
      return (data ?? []) as PreviewMatch[];
    },
  });
}

type AlertsFunctionResponse = {
  ok?: boolean;
  status?: string;
  created?: number;
  paused?: number;
  pending?: number;
  error?: string;
  message?: string;
};

/** Chama a função alerts; erros HTTP viram Error com a mensagem pt-BR da função. */
async function callAlerts(body: Record<string, unknown>): Promise<AlertsFunctionResponse> {
  const { data, error } = await supabase.functions.invoke<AlertsFunctionResponse>("alerts", { body });
  if (error) {
    const context = (error as { context?: Response }).context;
    const payload = context ? ((await context.json().catch(() => null)) as AlertsFunctionResponse | null) : null;
    throw new Error(payload?.message ?? "Não foi possível falar com o servidor. Tente de novo.");
  }
  return data ?? {};
}

export function useApproveAlert(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (alertId: string) => callAlerts({ action: "approve", alert_id: alertId }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: alertKeys.all(workspaceId) });
      // O objeto pausado muda de status na árvore de Campanhas.
      qc.invalidateQueries({ queryKey: ["meta", workspaceId] });
    },
  });
}

export function useDismissAlert(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (alertId: string) => {
      const { error } = await supabase.rpc("dismiss_alert", { p_alert_id: alertId });
      if (error) throw error;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: alertKeys.all(workspaceId) }),
  });
}

export function useEvaluateNow(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const result = await callAlerts({ action: "evaluate", workspace_id: workspaceId });
      return { created: result.created ?? 0, paused: result.paused ?? 0 };
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: alertKeys.all(workspaceId) });
      qc.invalidateQueries({ queryKey: ["meta", workspaceId] });
    },
  });
}
