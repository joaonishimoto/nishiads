/**
 * Escritas na Meta Ads: pausar, ativar e mudar o orçamento de campanha, conjunto ou anúncio.
 *
 * Usado pela função meta-actions (botões do app) e pelas regras automáticas. Quem chama
 * confere o papel do usuário; aqui ficam o token, a chamada à Graph API, a releitura do
 * objeto (e dos filhos, cujo effective_status muda junto) e o registro em meta_action_log.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage, log } from "../log.ts";
import { GraphClient, MetaApiError } from "./graph.ts";
import { budgetToCents, centsToBudget } from "./mapping.ts";
import { markNeedsReconnect } from "./sync.ts";

export type MetaLevel = "campaign" | "adset" | "ad";
export type MetaStatus = "ACTIVE" | "PAUSED";
export type MetaActionSource = "manual" | "rule";

/** Permissão da Meta que libera escrita (o login antigo só tinha ads_read). */
export const WRITE_SCOPE = "ads_management";

/** Teto de segurança por chamada: R$ 1 milhão por dia (ou total). */
export const MAX_BUDGET_CENTS = 100_000_000;

export type ObjectState = {
  status: string | null;
  effective_status: string | null;
  daily_budget_cents: number | null;
  lifetime_budget_cents: number | null;
};

export type WriteErrorKind =
  | "invalid"
  | "not_found"
  | "needs_reconnect"
  | "missing_permission"
  | "rate_limit"
  | "meta_error"
  | "internal";

export type WriteResult =
  | { ok: true; object: ObjectState }
  | { ok: false; kind: WriteErrorKind; error: string };

type BaseInput = {
  workspaceId: string;
  level: MetaLevel;
  /** Nosso uuid (campaigns.id, adsets.id ou ads.id). */
  objectId: string;
  actorUserId: string | null;
  source: MetaActionSource;
  /** Livre, vai para o log (ex.: { rule_id, reason }). */
  context?: Record<string, unknown>;
};

export type WriteOptions = { appSecret?: string | null; fetchFn?: typeof fetch };

const TABLE: Record<MetaLevel, "campaigns" | "adsets" | "ads"> = {
  campaign: "campaigns",
  adset: "adsets",
  ad: "ads",
};

type ObjectRow = {
  id: string;
  external_id: string;
  name: string;
  ad_account_id: string;
  status: string | null;
  effective_status: string | null;
  daily_budget_cents?: number | null;
  lifetime_budget_cents?: number | null;
};

type Prepared = {
  admin: SupabaseClient;
  input: BaseInput;
  row: ObjectRow;
  currency: string;
  graph: GraphClient;
  connectionId: string;
};

type LiveBudget = { daily_budget?: string; lifetime_budget?: string };
type LiveObject = LiveBudget & { id?: string; status?: string; effective_status?: string };

class WriteError extends Error {
  constructor(readonly kind: WriteErrorKind, message: string) {
    super(message);
  }
}

function appSecretOf(options: WriteOptions): string | null {
  if (options.appSecret !== undefined) return options.appSecret;
  return (typeof Deno !== "undefined" ? Deno.env.get("META_APP_SECRET")?.trim() : undefined) || null;
}

type Refused = { ok: false; kind: WriteErrorKind; error: string; row: ObjectRow | null };

const RECONNECT = "Reconecte a Meta para controlar os anúncios por aqui.";

/** Carrega o objeto, a conta e o token. Recusa (sem chamar a Meta) quando falta algo. */
async function prepare(admin: SupabaseClient, input: BaseInput, options: WriteOptions): Promise<Prepared | Refused> {
  const columns = input.level === "ad"
    ? "id, external_id, name, ad_account_id, status, effective_status"
    : "id, external_id, name, ad_account_id, status, effective_status, daily_budget_cents, lifetime_budget_cents";
  const { data, error } = await admin
    .from(TABLE[input.level])
    .select(columns)
    .eq("id", input.objectId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (error) throw new Error(`${TABLE[input.level]}: ${error.message}`);
  if (!data) return { ok: false, kind: "not_found", error: "Não encontramos esse item. Sincronize e tente de novo.", row: null };
  const row = data as unknown as ObjectRow;
  const refuse = (kind: WriteErrorKind, message: string): Refused => ({ ok: false, kind, error: message, row });

  const { data: account } = await admin
    .from("ad_accounts")
    .select("id, currency, status, meta_connection_id")
    .eq("id", row.ad_account_id)
    .maybeSingle();
  if (!account?.meta_connection_id || account.status === "needs_reconnect") return refuse("needs_reconnect", RECONNECT);
  const { data: connection } = await admin
    .from("meta_connections")
    .select("id, status, token_ref, scopes")
    .eq("id", account.meta_connection_id)
    .maybeSingle();
  if (!connection || connection.status !== "active" || !connection.token_ref) return refuse("needs_reconnect", RECONNECT);
  if (!((connection.scopes as string[] | null) ?? []).includes(WRITE_SCOPE)) {
    return refuse("missing_permission", "Falta a permissão ads_management. Reconecte a Meta e aceite todas as permissões.");
  }
  const { data: token, error: tokenError } = await admin.rpc("service_read_secret", { p_secret_id: connection.token_ref });
  if (tokenError || !token) throw new Error(tokenError?.message ?? "Token da Meta não encontrado no Vault.");
  return {
    admin,
    input,
    row,
    currency: (account.currency as string) || "BRL",
    connectionId: connection.id as string,
    graph: new GraphClient({ accessToken: token as string, appSecret: appSecretOf(options), fetchFn: options.fetchFn }),
  };
}

function stateFrom(live: LiveObject, level: MetaLevel, currency: string): ObjectState {
  return {
    status: live.status ?? null,
    effective_status: live.effective_status ?? null,
    daily_budget_cents: level === "ad" ? null : budgetToCents(live.daily_budget, currency),
    lifetime_budget_cents: level === "ad" ? null : budgetToCents(live.lifetime_budget, currency),
  };
}

function columnsFrom(state: ObjectState, level: MetaLevel): Record<string, unknown> {
  const values: Record<string, unknown> = { status: state.status, effective_status: state.effective_status };
  if (level !== "ad") {
    values.daily_budget_cents = state.daily_budget_cents;
    values.lifetime_budget_cents = state.lifetime_budget_cents;
  }
  return values;
}

/** Atualiza vários filhos com os mesmos valores numa chamada só. */
async function updateChildren(p: Prepared, level: MetaLevel, rows: LiveObject[]) {
  const groups = new Map<string, { values: Record<string, unknown>; ids: string[] }>();
  for (const r of rows) {
    if (!r.id) continue;
    const values = columnsFrom(stateFrom(r, level, p.currency), level);
    const key = JSON.stringify(values);
    const group = groups.get(key) ?? { values, ids: [] };
    group.ids.push(r.id);
    groups.set(key, group);
  }
  for (const { values, ids } of groups.values()) {
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await p.admin
        .from(TABLE[level])
        .update(values)
        .eq("ad_account_id", p.row.ad_account_id)
        .in("external_id", ids.slice(i, i + 200));
      if (error) throw new Error(`${TABLE[level]}: ${error.message}`);
    }
  }
}

async function collect(graph: GraphClient, path: string, fields: string): Promise<LiveObject[]> {
  const all: LiveObject[] = [];
  for await (const page of graph.paginate<LiveObject>(path, { fields, limit: 200 }, 20)) all.push(...page);
  return all;
}

const BUDGET_FIELDS = "id,status,effective_status,daily_budget,lifetime_budget";
const AD_FIELDS = "id,status,effective_status";

/** Relê o objeto na Meta e grava; pausar uma campanha muda o effective_status dos filhos. */
async function refresh(p: Prepared): Promise<ObjectState> {
  const { level, row } = { level: p.input.level, row: p.row };
  const live = await p.graph.get<LiveObject>(row.external_id, { fields: level === "ad" ? AD_FIELDS : BUDGET_FIELDS });
  const state = stateFrom(live, level, p.currency);
  const { error } = await p.admin.from(TABLE[level]).update(columnsFrom(state, level)).eq("id", row.id);
  if (error) throw new Error(`${TABLE[level]}: ${error.message}`);
  try {
    if (level === "campaign") {
      await updateChildren(p, "adset", await collect(p.graph, `${row.external_id}/adsets`, BUDGET_FIELDS));
    }
    if (level !== "ad") await updateChildren(p, "ad", await collect(p.graph, `${row.external_id}/ads`, AD_FIELDS));
  } catch (cause) {
    // Os filhos se acertam na próxima sincronização (15 min).
    log("warn", "meta_write_children_refresh_failed", { objectId: row.id, error: errorMessage(cause) });
  }
  return state;
}

async function record(
  admin: SupabaseClient,
  input: BaseInput,
  row: ObjectRow,
  entry: { action: "pause" | "activate" | "set_budget"; previous: unknown; requested: unknown; ok: boolean; error?: string },
) {
  const { error } = await admin.from("meta_action_log").insert({
    workspace_id: input.workspaceId,
    ad_account_id: row.ad_account_id,
    level: input.level,
    object_id: row.id,
    external_id: row.external_id,
    object_name: row.name,
    action: entry.action,
    previous: entry.previous ?? null,
    requested: entry.requested ?? {},
    ok: entry.ok,
    error: entry.error?.slice(0, 1000) ?? null,
    source: input.source,
    actor_user_id: input.actorUserId,
    context: input.context ?? {},
  });
  if (error) log("error", "meta_action_log_insert_failed", { objectId: row.id, error: error.message });
}

/** Traduz o erro da Meta para o resultado, marcando a conexão quando o token caiu. */
async function fromMetaError(p: Prepared, cause: unknown): Promise<{ kind: WriteErrorKind; error: string }> {
  if (cause instanceof WriteError) return { kind: cause.kind, error: cause.message };
  if (!(cause instanceof MetaApiError)) {
    return { kind: "internal", error: `Erro inesperado: ${errorMessage(cause)}`.slice(0, 300) };
  }
  switch (cause.kind) {
    case "token":
      await markNeedsReconnect(p.admin, p.connectionId, cause.message);
      return { kind: "needs_reconnect", error: "O acesso à Meta expirou. Reconecte em Integrações." };
    case "permission":
      return {
        kind: "missing_permission",
        error: cause.userMessage ?? "A Meta recusou: seu usuário não tem permissão para editar esta conta de anúncio.",
      };
    case "rate_limit":
      return { kind: "rate_limit", error: "A Meta pediu para esperar um pouco. Tente de novo em alguns minutos." };
    default:
      return { kind: "meta_error", error: cause.userMessage ?? cause.message };
  }
}

type Plan = {
  action: "pause" | "activate" | "set_budget";
  previous: unknown;
  requested: unknown;
  /** Faz a escrita na Meta (pode lançar MetaApiError ou WriteError). */
  write: () => Promise<void>;
};

/** Nunca lança: erro inesperado (banco, Vault) volta como kind "internal". */
async function perform(
  admin: SupabaseClient,
  input: BaseInput,
  options: WriteOptions,
  plan: (p: Prepared) => Promise<Plan> | Plan,
  fallbackAction: Plan["action"],
  fallbackRequested: unknown,
): Promise<WriteResult> {
  try {
    return await performUnsafe(admin, input, options, plan, fallbackAction, fallbackRequested);
  } catch (cause) {
    log("error", "meta_write_internal_error", { objectId: input.objectId, error: errorMessage(cause) });
    return { ok: false, kind: "internal", error: "Erro inesperado ao falar com a Meta. Tente de novo." };
  }
}

async function performUnsafe(
  admin: SupabaseClient,
  input: BaseInput,
  options: WriteOptions,
  plan: (p: Prepared) => Promise<Plan> | Plan,
  fallbackAction: Plan["action"],
  fallbackRequested: unknown,
): Promise<WriteResult> {
  const prepared = await prepare(admin, input, options);
  if ("ok" in prepared) {
    if (prepared.row) {
      await record(admin, input, prepared.row, {
        action: fallbackAction,
        previous: null,
        requested: fallbackRequested,
        ok: false,
        error: prepared.error,
      });
    }
    return { ok: false, kind: prepared.kind, error: prepared.error };
  }

  let steps: Plan | null = null;
  try {
    steps = await plan(prepared);
    await steps.write();
  } catch (cause) {
    const failure = await fromMetaError(prepared, cause);
    await record(admin, input, prepared.row, {
      action: steps?.action ?? fallbackAction,
      previous: steps?.previous ?? null,
      requested: steps?.requested ?? fallbackRequested,
      ok: false,
      error: failure.error,
    });
    log("warn", "meta_write_failed", { objectId: input.objectId, level: input.level, ...failure });
    return { ok: false, ...failure };
  }

  await record(admin, input, prepared.row, { ...steps, ok: true });
  let object: ObjectState;
  try {
    object = await refresh(prepared);
  } catch (cause) {
    // A escrita deu certo; só a releitura falhou. Devolve o que pedimos.
    log("warn", "meta_write_refresh_failed", { objectId: input.objectId, error: errorMessage(cause) });
    object = {
      status: prepared.row.status,
      effective_status: prepared.row.effective_status,
      daily_budget_cents: prepared.row.daily_budget_cents ?? null,
      lifetime_budget_cents: prepared.row.lifetime_budget_cents ?? null,
      ...(steps.requested as Partial<ObjectState>),
      ...(steps.action === "pause" ? { effective_status: "PAUSED" } : {}),
    };
  }
  log("info", "meta_write_ok", { objectId: input.objectId, level: input.level, action: steps.action, source: input.source });
  return { ok: true, object };
}

/** Pausa ou ativa uma campanha, conjunto ou anúncio. */
export function setMetaObjectStatus(
  admin: SupabaseClient,
  input: BaseInput & { status: MetaStatus },
  options: WriteOptions = {},
): Promise<WriteResult> {
  const action = input.status === "PAUSED" ? "pause" : "activate";
  if (input.status !== "PAUSED" && input.status !== "ACTIVE") {
    return Promise.resolve({ ok: false, kind: "invalid", error: "Status inválido." });
  }
  return perform(admin, input, options, (p) => ({
    action,
    previous: { status: p.row.status, effective_status: p.row.effective_status },
    requested: { status: input.status },
    write: async () => {
      await p.graph.post(p.row.external_id, { status: input.status });
    },
  }), action, { status: input.status });
}

/**
 * Muda o orçamento (diário ou total, o tipo que o objeto já usa) de uma campanha ou conjunto.
 * Confere na Meta onde o orçamento está: conjunto de campanha com orçamento de campanha
 * (CBO) não tem orçamento próprio.
 */
export function setMetaBudget(
  admin: SupabaseClient,
  input: BaseInput & { level: "campaign" | "adset"; budgetCents: number },
  options: WriteOptions = {},
): Promise<WriteResult> {
  if (input.level !== "campaign" && input.level !== "adset") {
    return Promise.resolve({ ok: false, kind: "invalid", error: "Anúncio não tem orçamento próprio." });
  }
  if (!Number.isSafeInteger(input.budgetCents) || input.budgetCents < 100 || input.budgetCents > MAX_BUDGET_CENTS) {
    return Promise.resolve({ ok: false, kind: "invalid", error: "Orçamento fora do limite permitido." });
  }
  return perform(admin, input, options, async (p) => {
    const fields = input.level === "adset" ? "daily_budget,lifetime_budget,campaign{daily_budget,lifetime_budget}" : "daily_budget,lifetime_budget";
    const live = await p.graph.get<LiveBudget & { campaign?: LiveBudget }>(p.row.external_id, { fields });
    const daily = budgetToCents(live.daily_budget, p.currency);
    const lifetime = budgetToCents(live.lifetime_budget, p.currency);
    const field = daily !== null ? "daily_budget" : lifetime !== null ? "lifetime_budget" : null;
    if (!field) {
      const campaignBudget = live.campaign && (budgetToCents(live.campaign.daily_budget, p.currency) ??
        budgetToCents(live.campaign.lifetime_budget, p.currency));
      throw new WriteError(
        "invalid",
        input.level === "adset" && campaignBudget
          ? "Este conjunto usa o orçamento da campanha (CBO). Mude o orçamento na campanha."
          : "Esta campanha não tem orçamento próprio: o orçamento fica nos conjuntos.",
      );
    }
    const value = centsToBudget(input.budgetCents, p.currency);
    if (value < 1) throw new WriteError("invalid", "Orçamento muito baixo.");
    const column = `${field}_cents`;
    return {
      action: "set_budget",
      previous: { [column]: field === "daily_budget" ? daily : lifetime },
      requested: { [column]: input.budgetCents },
      write: async () => {
        await p.graph.post(p.row.external_id, { [field]: value });
      },
    };
  }, "set_budget", { budget_cents: input.budgetCents });
}
