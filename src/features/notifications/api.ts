import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Tables } from "@/types/database";
import { currentPushSubscription, subscribeToPush } from "@/features/notifications/push";

export type NotificationPreferences = Tables<"notification_preferences">;
export type PushDevice = Pick<
  Tables<"notification_subscriptions">,
  "id" | "endpoint" | "user_agent" | "active" | "last_used_at" | "created_at"
>;

export const notificationKeys = {
  preferences: (workspaceId: string, userId: string) => ["notifications", workspaceId, userId, "preferences"] as const,
  devices: (workspaceId: string, userId: string) => ["notifications", workspaceId, userId, "devices"] as const,
  thisDevice: ["notifications", "this-device"] as const,
  config: ["notifications", "config"] as const,
};

type PushFunctionResponse = { publicKey?: string; sent?: number; delivered?: number; error?: string };

async function callPush(body: Record<string, unknown>): Promise<PushFunctionResponse> {
  const { data, error } = await supabase.functions.invoke<PushFunctionResponse>("push", { body });
  if (error) {
    // Erro HTTP da função: tenta ler o código para uma mensagem melhor.
    const context = (error as { context?: Response }).context;
    const payload = context ? ((await context.json().catch(() => null)) as PushFunctionResponse | null) : null;
    if (payload?.error === "push_not_configured") throw new Error("push_not_configured");
    throw error;
  }
  return data ?? {};
}

export function usePushConfig() {
  return useQuery({
    queryKey: notificationKeys.config,
    queryFn: async () => (await callPush({ action: "config" })).publicKey ?? null,
    staleTime: Infinity,
    retry: false,
  });
}

/** Endpoint de push deste navegador (null se não inscrito). */
export function useThisDeviceEndpoint() {
  return useQuery({
    queryKey: notificationKeys.thisDevice,
    queryFn: async () => (await currentPushSubscription())?.endpoint ?? null,
  });
}

export function usePushDevices(workspaceId: string, userId: string) {
  return useQuery({
    queryKey: notificationKeys.devices(workspaceId, userId),
    queryFn: async (): Promise<PushDevice[]> => {
      const { data, error } = await supabase
        .from("notification_subscriptions")
        .select("id, endpoint, user_agent, active, last_used_at, created_at")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .eq("channel", "webpush")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useEnablePush(workspaceId: string, userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (publicKey: string) => {
      const subscription = await subscribeToPush(publicKey);
      if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys.auth) {
        throw new Error("Inscrição de push incompleta.");
      }
      const { error } = await supabase.rpc("register_push_subscription", {
        p_workspace_id: workspaceId,
        p_endpoint: subscription.endpoint,
        p_p256dh: subscription.keys.p256dh,
        p_auth: subscription.keys.auth,
        p_user_agent: navigator.userAgent,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notificationKeys.thisDevice });
      qc.invalidateQueries({ queryKey: notificationKeys.devices(workspaceId, userId) });
    },
  });
}

/** Remove o dispositivo da lista. Se for este navegador, cancela também a inscrição local. */
export function useRemoveDevice(workspaceId: string, userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (device: Pick<PushDevice, "id" | "endpoint">) => {
      const { error } = await supabase.from("notification_subscriptions").delete().eq("id", device.id);
      if (error) throw error;
      const local = await currentPushSubscription();
      if (local && local.endpoint === device.endpoint) {
        // O mesmo navegador pode estar inscrito em outro workspace: só cancela se não restar nenhum.
        const { count } = await supabase
          .from("notification_subscriptions")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("endpoint", device.endpoint);
        if (!count) await local.unsubscribe();
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notificationKeys.thisDevice });
      qc.invalidateQueries({ queryKey: notificationKeys.devices(workspaceId, userId) });
    },
  });
}

export function useSendTestPush(workspaceId: string) {
  return useMutation({
    mutationFn: async () => {
      const result = await callPush({ action: "test", workspace_id: workspaceId });
      return { sent: result.sent ?? 0, delivered: result.delivered ?? 0 };
    },
  });
}

export function useNotificationPreferences(workspaceId: string, userId: string) {
  return useQuery({
    queryKey: notificationKeys.preferences(workspaceId, userId),
    queryFn: async (): Promise<NotificationPreferences> => {
      const { data, error } = await supabase
        .from("notification_preferences")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .single();
      if (error) throw error;
      return data;
    },
  });
}

export type PreferencesPatch = Partial<
  Pick<
    NotificationPreferences,
    | "notify_approved"
    | "notify_refunded"
    | "notify_chargeback"
    | "min_amount_cents"
    | "quiet_hours_start"
    | "quiet_hours_end"
    | "sound_enabled"
    | "notify_alerts"
    | "notify_registrations"
    | "notify_trials"
  >
>;

export function useUpdatePreferences(workspaceId: string, userId: string) {
  const qc = useQueryClient();
  const key = notificationKeys.preferences(workspaceId, userId);
  return useMutation({
    mutationFn: async (patch: PreferencesPatch) => {
      const { error } = await supabase
        .from("notification_preferences")
        .update(patch)
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId);
      if (error) throw error;
    },
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<NotificationPreferences>(key);
      if (previous) qc.setQueryData(key, { ...previous, ...patch });
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}
