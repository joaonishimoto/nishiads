import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { MetaCapiEventStatus, Tables } from "@/types/database";

export type CapiConfig = Tables<"meta_capi_configs">;
export type CapiEvent = Pick<
  Tables<"meta_capi_events">,
  | "id"
  | "sale_id"
  | "event_name"
  | "event_id"
  | "event_time"
  | "is_test"
  | "status"
  | "attempts"
  | "next_attempt_at"
  | "last_error"
  | "request"
  | "response"
  | "sent_at"
  | "created_at"
>;

export const capiKeys = {
  config: (workspaceId: string) => ["meta-capi", workspaceId, "config"] as const,
  events: (workspaceId: string, status: string) =>
    ["meta-capi", workspaceId, "events", status] as const,
  all: (workspaceId: string) => ["meta-capi", workspaceId] as const,
};

const CONFIG_COLUMNS =
  "workspace_id, pixel_id, has_token, event_source_url, test_event_code, enabled, send_trials, send_refunds, " +
  "last_sent_at, last_error, last_error_at, updated_by, created_at, updated_at";

export function useCapiConfig(workspaceId: string) {
  return useQuery({
    queryKey: capiKeys.config(workspaceId),
    queryFn: async (): Promise<CapiConfig | null> => {
      const { data, error } = await supabase
        .from("meta_capi_configs")
        .select(CONFIG_COLUMNS)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as CapiConfig | null) ?? null;
    },
  });
}

/** Contagem dos últimos 7 dias, por status (só owner/admin enxergam a fila). */
export function useCapiStats(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...capiKeys.all(workspaceId), "stats"],
    enabled,
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const count = async (status: MetaCapiEventStatus) => {
        const { count, error } = await supabase
          .from("meta_capi_events")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .eq("is_test", false)
          .eq("status", status)
          .gte("created_at", since);
        if (error) throw error;
        return count ?? 0;
      };
      const [sent, pending, failed] = await Promise.all([
        count("sent"),
        count("pending"),
        count("failed"),
      ]);
      return { sent, pending, failed };
    },
    refetchInterval: 30_000,
  });
}

type FunctionError = { error?: string };

/** Chama a função meta-capi; devolve o corpo mesmo em erro (o teste explica o motivo). */
async function invokeCapi<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("meta-capi", { body });
  if (error) {
    const context = (error as { context?: Response }).context;
    const payload = context
      ? ((await context.json().catch(() => null)) as (T & FunctionError) | null)
      : null;
    if (payload) return payload;
    throw new Error("function_error");
  }
  return data as T;
}

export function capiErrorMessage(code: string | undefined): string {
  switch (code) {
    case "not_configured":
      return "Salve o pixel e o token antes de testar.";
    case "test_code_required":
      return "Cole o código de teste do Gerenciador de Eventos para mandar um evento de teste.";
    case "forbidden":
      return "Só owners e admins podem fazer isso.";
    case "unauthorized":
      return "Sua sessão expirou. Entre novamente.";
    case "invalid_body":
    case "internal_error":
    case "function_error":
    case undefined:
      return "Não foi possível falar com a Meta agora. Tente de novo.";
    default:
      return code;
  }
}

export type SaveCapiValues = {
  pixelId: string;
  eventSourceUrl: string;
  accessToken?: string;
  testEventCode?: string;
  enabled: boolean;
  sendTrials: boolean;
  sendRefunds: boolean;
};

export function useSaveCapiConfig(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: SaveCapiValues) => {
      const { error } = await supabase.rpc("save_meta_capi_config", {
        p_workspace_id: workspaceId,
        p_pixel_id: values.pixelId,
        p_event_source_url: values.eventSourceUrl,
        p_access_token: values.accessToken || null,
        p_test_event_code: values.testEventCode || null,
        p_enabled: values.enabled,
        p_send_trials: values.sendTrials,
        p_send_refunds: values.sendRefunds,
      });
      if (error) throw error;
      // O que estava esperando (ex.: token trocado) vai na hora. Falha aqui não desfaz o salvar.
      if (values.enabled)
        await invokeCapi({ action: "flush", workspace_id: workspaceId }).catch(() => undefined);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: capiKeys.all(workspaceId) }),
  });
}

export function useDeleteCapiConfig(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("delete_meta_capi_config", {
        p_workspace_id: workspaceId,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: capiKeys.all(workspaceId) }),
  });
}

export function useCapiBackfill(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("enqueue_meta_capi_backfill", {
        p_workspace_id: workspaceId,
      });
      if (error) throw error;
      if (data)
        await invokeCapi({ action: "flush", workspace_id: workspaceId }).catch(() => undefined);
      return data ?? 0;
    },
    // O envio roda em segundo plano: recarrega em instantes.
    onSuccess: () =>
      setTimeout(() => qc.invalidateQueries({ queryKey: capiKeys.all(workspaceId) }), 3000),
  });
}

export type TestResult =
  | { ok: true; events_received: number | null; fbtrace_id: string | null }
  | { ok: false; error?: string };

export function useCapiTest(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invokeCapi<TestResult>({ action: "test", workspace_id: workspaceId }),
    onSettled: () => qc.invalidateQueries({ queryKey: capiKeys.all(workspaceId) }),
  });
}

export function useRetryCapiEvent(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (eventId: number) => {
      const { error } = await supabase.rpc("retry_meta_capi_event", { p_event_id: eventId });
      if (error) throw error;
      await invokeCapi({ action: "flush", workspace_id: workspaceId, event_id: eventId });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: capiKeys.all(workspaceId) }),
  });
}

const PAGE = 50;

export function useCapiEvents(workspaceId: string, status: MetaCapiEventStatus | "all") {
  return useInfiniteQuery({
    queryKey: capiKeys.events(workspaceId, status),
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<CapiEvent[]> => {
      let query = supabase
        .from("meta_capi_events")
        .select(
          "id, sale_id, event_name, event_id, event_time, is_test, status, attempts, next_attempt_at, last_error, " +
            "request, response, sent_at, created_at",
        )
        .eq("workspace_id", workspaceId);
      if (status !== "all") query = query.eq("status", status);
      const { data, error } = await query
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(pageParam * PAGE, pageParam * PAGE + PAGE - 1);
      if (error) throw error;
      return (data ?? []) as unknown as CapiEvent[];
    },
    getNextPageParam: (last, pages) => (last.length === PAGE ? pages.length : undefined),
  });
}
