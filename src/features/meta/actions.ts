import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { AdStructure } from "@/features/results/metrics";
import type { AdAccount, MetaConnection } from "@/features/meta/api";
import type { MetaActionKind, MetaActionLevel } from "@/types/database";

/** Permissão da Meta que libera pausar, ativar e mudar orçamento. */
export const WRITE_SCOPE = "ads_management";

export type MetaAction =
  | { level: MetaActionLevel; id: string; action: "pause" | "activate" }
  | { level: "campaign" | "adset"; id: string; action: "set_budget"; budgetCents: number };

export type ObjectState = {
  status: string | null;
  effective_status: string | null;
  daily_budget_cents: number | null;
  lifetime_budget_cents: number | null;
};

/** Por que a chave está travada para esta conta (null = liberada). */
export type ControlBlock = "viewer" | "needs_scope" | "needs_reconnect";

export function controlBlock(
  account: Pick<AdAccount, "status" | "meta_connection_id"> | undefined,
  connections: Pick<MetaConnection, "id" | "status" | "scopes">[],
  canManage: boolean,
): ControlBlock | null {
  if (!canManage) return "viewer";
  const connection = connections.find((c) => c.id === account?.meta_connection_id);
  if (
    !account ||
    !connection ||
    connection.status !== "active" ||
    account.status === "needs_reconnect"
  ) {
    return "needs_reconnect";
  }
  return connection.scopes.includes(WRITE_SCOPE) ? null : "needs_scope";
}

export class MetaActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MetaActionError";
  }
}

const FALLBACK: Record<string, string> = {
  forbidden: "Só owners e admins podem mudar campanhas.",
  unauthorized: "Sua sessão expirou. Entre novamente.",
  too_many_actions: "Muitas alterações seguidas. Espere um minuto.",
  needs_reconnect: "Reconecte a Meta em Integrações para controlar os anúncios por aqui.",
  missing_permission: "Falta a permissão de gerenciar anúncios. Reconecte a Meta em Integrações.",
  rate_limit: "A Meta pediu para esperar um pouco. Tente de novo em alguns minutos.",
};

/** Chama meta-actions. Erros viram MetaActionError com o código e a mensagem da função. */
async function callMetaAction(workspaceId: string, input: MetaAction): Promise<ObjectState> {
  const body =
    input.action === "set_budget"
      ? {
          workspace_id: workspaceId,
          level: input.level,
          id: input.id,
          action: input.action,
          budget_cents: input.budgetCents,
        }
      : { workspace_id: workspaceId, level: input.level, id: input.id, action: input.action };
  const { data, error } = await supabase.functions.invoke<{ ok: true; object: ObjectState }>(
    "meta-actions",
    { body },
  );
  if (error) {
    const context = (error as { context?: Response }).context;
    const payload = context
      ? ((await context.json().catch(() => null)) as { error?: string; message?: string } | null)
      : null;
    const code = payload?.error ?? "function_error";
    throw new MetaActionError(
      code,
      payload?.message ??
        FALLBACK[code] ??
        "Não foi possível falar com a Meta agora. Tente de novo.",
    );
  }
  return data!.object;
}

export function metaActionMessage(error: unknown): string {
  if (error instanceof MetaActionError) return error.message;
  return "Não foi possível falar com a Meta agora. Tente de novo.";
}

const TABLE_KEY = { campaign: "campaigns", adset: "adsets", ad: "ads" } as const;

/** O que esperamos ver depois da ação: aplicado na hora e desfeito se a Meta recusar. */
export function optimisticPatch(input: MetaAction): Partial<ObjectState> {
  if (input.action === "pause") return { status: "PAUSED", effective_status: "PAUSED" };
  if (input.action === "activate") return { status: "ACTIVE", effective_status: "ACTIVE" };
  return {};
}

/** Aplica um patch no objeto e, ao pausar/ativar, no effective_status dos filhos. */
export function patchStructure(
  structure: AdStructure,
  input: Pick<MetaAction, "level" | "id">,
  patch: Partial<ObjectState>,
  budgetPatch?: { daily?: number | null; lifetime?: number | null },
): AdStructure {
  const key = TABLE_KEY[input.level];
  const apply = <T extends { id: string }>(rows: T[]) =>
    rows.map((r) =>
      r.id === input.id
        ? {
            ...r,
            ...patch,
            ...(budgetPatch && "daily" in budgetPatch
              ? { daily_budget_cents: budgetPatch.daily }
              : {}),
            ...(budgetPatch && "lifetime" in budgetPatch
              ? { lifetime_budget_cents: budgetPatch.lifetime }
              : {}),
          }
        : r,
    );
  const next: AdStructure = { ...structure, [key]: apply(structure[key]) } as AdStructure;
  // Pausar a campanha/conjunto: os filhos que estavam entregando passam a "pausado acima".
  const parentPaused = patch.status === "PAUSED";
  const childStatus = input.level === "campaign" ? "CAMPAIGN_PAUSED" : "ADSET_PAUSED";
  const isChild = (r: { campaign_id?: string; adset_id?: string }) =>
    input.level === "campaign"
      ? r.campaign_id === input.id
      : input.level === "adset" && r.adset_id === input.id;
  if (input.level !== "ad" && patch.status) {
    const touch = <
      T extends {
        campaign_id?: string;
        adset_id?: string;
        effective_status: string | null;
        status?: string | null;
      },
    >(
      rows: T[],
    ) =>
      rows.map((r) => {
        if (!isChild(r)) return r;
        if (parentPaused && r.effective_status === "ACTIVE")
          return { ...r, effective_status: childStatus };
        if (!parentPaused && r.effective_status === childStatus && r.status === "ACTIVE") {
          return { ...r, effective_status: "ACTIVE" };
        }
        return r;
      });
    if (input.level === "campaign") next.adsets = touch(next.adsets);
    next.ads = touch(next.ads);
  }
  return next;
}

export const actionLogKey = (workspaceId: string) => ["meta", workspaceId, "action-log"] as const;

export function useMetaAction(workspaceId: string) {
  const qc = useQueryClient();
  const structureKey = ["meta", workspaceId, "structure"];
  return useMutation({
    mutationFn: (input: MetaAction) => callMetaAction(workspaceId, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: structureKey });
      const previous = qc.getQueriesData<AdStructure>({ queryKey: structureKey });
      const budget =
        input.action === "set_budget"
          ? qc
              .getQueriesData<AdStructure>({ queryKey: structureKey })
              .map(([, d]) =>
                d?.[TABLE_KEY[input.level] as "campaigns" | "adsets"].find(
                  (r) => r.id === input.id,
                ),
              )
              .find(Boolean)
          : undefined;
      // Orçamento: troca o valor do tipo que o objeto já usa (diário ou total).
      const budgetPatch =
        input.action === "set_budget"
          ? budget?.lifetime_budget_cents && !budget.daily_budget_cents
            ? { lifetime: input.budgetCents }
            : { daily: input.budgetCents }
          : undefined;
      qc.setQueriesData<AdStructure>({ queryKey: structureKey }, (data) =>
        data ? patchStructure(data, input, optimisticPatch(input), budgetPatch) : data,
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      context?.previous.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSuccess: (object, input) => {
      qc.setQueriesData<AdStructure>({ queryKey: structureKey }, (data) =>
        data
          ? patchStructure(
              data,
              input,
              { status: object.status, effective_status: object.effective_status },
              input.level === "ad"
                ? undefined
                : { daily: object.daily_budget_cents, lifetime: object.lifetime_budget_cents },
            )
          : data,
      );
    },
    onSettled: () => {
      // O servidor já releu os filhos na Meta: busca a estrutura real.
      qc.invalidateQueries({ queryKey: structureKey });
      qc.invalidateQueries({ queryKey: actionLogKey(workspaceId) });
    },
  });
}

export type ActionLogEntry = {
  id: string;
  level: MetaActionLevel;
  object_id: string;
  object_name: string | null;
  action: MetaActionKind;
  previous: Record<string, unknown> | null;
  requested: Record<string, unknown>;
  ok: boolean;
  error: string | null;
  source: "manual" | "rule";
  created_at: string;
  ad_account_id: string | null;
  actor: { full_name: string | null; email: string } | null;
};

export function useMetaActionLog(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: actionLogKey(workspaceId),
    enabled,
    queryFn: async (): Promise<ActionLogEntry[]> => {
      const { data, error } = await supabase
        .from("meta_action_log")
        .select(
          "id, level, object_id, object_name, action, previous, requested, ok, error, source, created_at, ad_account_id, " +
            "actor:profiles(full_name, email)",
        )
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as ActionLogEntry[];
    },
  });
}
