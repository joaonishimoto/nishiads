import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { env } from "@/lib/env";
import type { CheckoutProvider, Tables, WebhookEventStatus } from "@/types/database";

export type Integration = Pick<
  Tables<"checkout_integrations">,
  "id" | "provider" | "name" | "active" | "last_event_at" | "created_at" | "webhook_url_token"
> & { has_secret: boolean };

export const integrationKeys = {
  list: (workspaceId: string) => ["integrations", workspaceId] as const,
  logs: (workspaceId: string, status: string) => ["integrations", workspaceId, "logs", status] as const,
};

/** URL pública do webhook. O token da URL identifica a integração; a assinatura prova a origem. */
export function webhookUrl(provider: CheckoutProvider, token: string): string {
  return `${env?.VITE_SUPABASE_URL ?? ""}/functions/v1/webhooks/${provider}/${token}`;
}

export function useIntegrations(workspaceId: string) {
  return useQuery({
    queryKey: integrationKeys.list(workspaceId),
    queryFn: async (): Promise<Integration[]> => {
      const { data, error } = await supabase
        .from("checkout_integrations")
        .select("id, provider, name, active, last_event_at, created_at, webhook_url_token, webhook_secret_ref")
        .eq("workspace_id", workspaceId)
        .order("created_at");
      if (error) throw error;
      // Só o fato de existir segredo vai para a interface; o id do Vault fica aqui.
      return (data ?? []).map(({ webhook_secret_ref, ...row }) => ({ ...row, has_secret: webhook_secret_ref !== null }));
    },
  });
}

export function useCreateIntegration(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: { provider: CheckoutProvider; name: string; secret?: string }) => {
      const { data, error } = await supabase.rpc("create_checkout_integration", {
        p_workspace_id: workspaceId,
        p_provider: values.provider,
        p_name: values.name,
        p_webhook_secret: values.secret || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.list(workspaceId) }),
  });
}

export function useSetIntegrationSecret(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: { integrationId: string; secret: string }) => {
      const { error } = await supabase.rpc("set_checkout_integration_secret", {
        p_integration_id: values.integrationId,
        p_webhook_secret: values.secret,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.list(workspaceId) }),
  });
}

export function useUpdateIntegration(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: { id: string; active?: boolean; name?: string }) => {
      const { id, ...patch } = values;
      const { error } = await supabase.from("checkout_integrations").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.list(workspaceId) }),
  });
}

export function useDeleteIntegration(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("checkout_integrations").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.list(workspaceId) }),
  });
}

export type WebhookLog = Pick<
  Tables<"webhook_events">,
  "id" | "provider" | "status" | "event_type" | "external_order_id" | "sale_id" | "error" | "payload" | "attempts" | "received_at"
> & { integration: { name: string } | null };

const LOG_PAGE = 50;

export function useWebhookLogs(workspaceId: string, status: WebhookEventStatus | "all") {
  return useInfiniteQuery({
    queryKey: integrationKeys.logs(workspaceId, status),
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<WebhookLog[]> => {
      let query = supabase
        .from("webhook_events")
        .select(
          "id, provider, status, event_type, external_order_id, sale_id, error, payload, attempts, received_at, " +
            "integration:checkout_integrations(name)",
        )
        .eq("workspace_id", workspaceId);
      if (status !== "all") query = query.eq("status", status);
      const { data, error } = await query
        .order("received_at", { ascending: false })
        .order("id", { ascending: false })
        .range(pageParam * LOG_PAGE, pageParam * LOG_PAGE + LOG_PAGE - 1);
      if (error) throw error;
      return (data ?? []) as unknown as WebhookLog[];
    },
    getNextPageParam: (last, pages) => (last.length === LOG_PAGE ? pages.length : undefined),
  });
}
