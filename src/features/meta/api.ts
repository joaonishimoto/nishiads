import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Tables } from "@/types/database";

export type MetaConnection = Pick<
  Tables<"meta_connections">,
  "id" | "meta_user_name" | "token_expires_at" | "status" | "last_error" | "created_at" | "updated_at"
>;

export type AdAccount = Pick<
  Tables<"ad_accounts">,
  | "id"
  | "external_id"
  | "name"
  | "currency"
  | "timezone"
  | "status"
  | "is_tracked"
  | "last_synced_at"
  | "last_sync_error"
  | "backfilled_at"
  | "meta_connection_id"
  | "sync_started_at"
  | "rate_limited_until"
>;

export const metaKeys = {
  connections: (workspaceId: string) => ["meta", workspaceId, "connections"] as const,
  accounts: (workspaceId: string) => ["meta", workspaceId, "accounts"] as const,
};

/** Trava mais velha que isso é de uma execução que morreu (mesma regra do banco). */
const STALE_SYNC_MS = 10 * 60_000;

export function isSyncing(account: Pick<AdAccount, "sync_started_at">): boolean {
  return !!account.sync_started_at && Date.now() - new Date(account.sync_started_at).getTime() < STALE_SYNC_MS;
}

type FunctionError = { error?: string };

/** Chama uma Edge Function e devolve o código de erro dela (ex.: meta_not_configured) como mensagem. */
async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body });
  if (error) {
    const context = (error as { context?: Response }).context;
    const payload = context ? ((await context.json().catch(() => null)) as FunctionError | null) : null;
    throw new Error(payload?.error ?? "function_error");
  }
  return data as T;
}

export function metaErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "meta_not_configured") {
    return "Falta configurar o app da Meta no Supabase (META_APP_ID e META_APP_SECRET).";
  }
  if (code === "forbidden") return "Só owners e admins podem fazer isso.";
  if (code === "unauthorized") return "Sua sessão expirou. Entre novamente.";
  return "Não foi possível falar com a Meta agora. Tente de novo.";
}

/** Mensagem para o ?meta_erro= que a função devolve ao voltar do Facebook. */
export function oauthReturnMessage(code: string): string {
  switch (code) {
    case "cancelado":
      return "Conexão cancelada no Facebook.";
    case "sem_permissao":
      return "A Meta não liberou a permissão ads_read. Conecte de novo e aceite todas as permissões.";
    case "sessao_expirada":
      return "A tentativa de conexão expirou. Clique em Conectar de novo.";
    default:
      return "Não foi possível concluir a conexão com a Meta. Tente de novo.";
  }
}

export function useMetaConnections(workspaceId: string) {
  return useQuery({
    queryKey: metaKeys.connections(workspaceId),
    queryFn: async (): Promise<MetaConnection[]> => {
      const { data, error } = await supabase
        .from("meta_connections")
        .select("id, meta_user_name, token_expires_at, status, last_error, created_at, updated_at")
        .eq("workspace_id", workspaceId)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useAdAccounts(workspaceId: string) {
  return useQuery({
    queryKey: metaKeys.accounts(workspaceId),
    queryFn: async (): Promise<AdAccount[]> => {
      const { data, error } = await supabase
        .from("ad_accounts")
        .select(
          "id, external_id, name, currency, timezone, status, is_tracked, last_synced_at, last_sync_error, " +
            "backfilled_at, meta_connection_id, sync_started_at, rate_limited_until",
        )
        .eq("workspace_id", workspaceId)
        .eq("platform", "meta")
        .order("is_tracked", { ascending: false })
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as AdAccount[];
    },
    // Enquanto alguma conta sincroniza, acompanha o andamento.
    refetchInterval: (query) => (query.state.data?.some(isSyncing) ? 3000 : false),
  });
}

export function useConnectMeta(workspaceId: string) {
  return useMutation({
    mutationFn: async () => {
      const returnTo = `${window.location.origin}/w/${workspaceId}/integracoes`;
      const { url } = await invoke<{ url: string }>("meta-oauth", {
        action: "start",
        workspace_id: workspaceId,
        return_to: returnTo,
      });
      window.location.assign(url);
    },
  });
}

export function useSyncNow(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (adAccountId?: string) =>
      invoke<{ started: number }>("meta-sync", {
        workspace_id: workspaceId,
        ...(adAccountId ? { ad_account_id: adAccountId } : {}),
      }),
    // A trava aparece em instantes; recarrega para começar o acompanhamento.
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: metaKeys.accounts(workspaceId) }), 800),
  });
}

export function useSetTracked(workspaceId: string) {
  const qc = useQueryClient();
  const sync = useSyncNow(workspaceId);
  const key = metaKeys.accounts(workspaceId);
  return useMutation({
    mutationFn: async ({ id, tracked }: { id: string; tracked: boolean }) => {
      const { error } = await supabase.from("ad_accounts").update({ is_tracked: tracked }).eq("id", id);
      if (error) throw error;
    },
    onMutate: async ({ id, tracked }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<AdAccount[]>(key);
      if (previous) qc.setQueryData(key, previous.map((a) => (a.id === id ? { ...a, is_tracked: tracked } : a)));
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
    onSuccess: (_data, { id, tracked }) => {
      // Conta recém-escolhida já começa o backfill de 30 dias.
      if (tracked) sync.mutate(id);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useDisconnectMeta(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const { error } = await supabase.rpc("disconnect_meta_connection", { p_connection_id: connectionId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: metaKeys.connections(workspaceId) });
      qc.invalidateQueries({ queryKey: metaKeys.accounts(workspaceId) });
    },
  });
}
