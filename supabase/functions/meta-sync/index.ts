/**
 * Sincronização da Meta Ads.
 *
 * POST /functions/v1/meta-sync   (header x-cron-secret: segredo do Vault)
 *   Chamado pelo pg_cron a cada 15 min: sincroniza as contas acompanhadas, as mais
 *   atrasadas primeiro, até o limite de tempo. As que sobrarem vão na próxima.
 *
 * POST /functions/v1/meta-sync   (Authorization: Bearer <access token do usuário>)
 *   { "workspace_id": "...", "ad_account_id"?: "..." } → 202 { started }
 *   Botão "Sincronizar agora" (qualquer membro). Roda em segundo plano; o app
 *   acompanha por ad_accounts.sync_started_at / last_synced_at.
 */
import { z } from "zod";
import { errorMessage, log } from "../_shared/log.ts";
import { SYNC_ACCOUNT_COLUMNS, syncAdAccount, type SyncAccount } from "../_shared/meta/sync.ts";
import { createAdminClient } from "../_shared/supabase-admin.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

/** Margem para o limite de 150 s das Edge Functions. */
const BUDGET_MS = 125_000;
/** Pelo cron, conta sincronizada há menos disso fica para a próxima. */
const CRON_MIN_INTERVAL_MS = 5 * 60_000;
/** Pelo botão, evita cliques repetidos. */
const MANUAL_MIN_INTERVAL_MS = 60_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

function runInBackground(task: Promise<unknown>): void {
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(task);
  else task.catch((e) => log("error", "background_task_failed", { error: errorMessage(e) }));
}

async function syncAll(accounts: SyncAccount[], deadline: number) {
  const admin = createAdminClient();
  const appSecret = Deno.env.get("META_APP_SECRET")?.trim() || null;
  const results: Record<string, number> = {};
  for (const account of accounts) {
    if (Date.now() > deadline - 10_000) {
      results.deferred = (results.deferred ?? 0) + 1;
      continue;
    }
    const outcome = await syncAdAccount(admin, account, { deadline, appSecret });
    const key = outcome.status === "skipped" ? `skipped_${outcome.reason}` : outcome.status;
    results[key] = (results[key] ?? 0) + 1;
  }
  return results;
}

const manualSchema = z.object({
  workspace_id: z.string().uuid(),
  ad_account_id: z.string().uuid().optional(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const deadline = Date.now() + BUDGET_MS;
  const admin = createAdminClient();

  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    const { data: ok } = await admin.rpc("service_check_cron_secret", { p_secret: cronSecret });
    if (!ok) return json(401, { error: "unauthorized" });
    const { data: accounts, error } = await admin
      .from("ad_accounts")
      .select(SYNC_ACCOUNT_COLUMNS)
      .eq("platform", "meta")
      .eq("is_tracked", true)
      .in("status", ["active", "error"])
      .or(`last_synced_at.is.null,last_synced_at.lt.${new Date(Date.now() - CRON_MIN_INTERVAL_MS).toISOString()}`)
      .order("last_synced_at", { ascending: true, nullsFirst: true })
      .limit(50);
    if (error) {
      log("error", "meta_sync_cron_lookup_failed", { error: error.message });
      return json(500, { error: "internal_error" });
    }
    const results = await syncAll((accounts ?? []) as SyncAccount[], deadline);
    log("info", "meta_sync_cron_done", { accounts: accounts?.length ?? 0, ...results });
    return json(200, { accounts: accounts?.length ?? 0, ...results });
  }

  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: auth, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !auth.user) return json(401, { error: "unauthorized" });

  const parsed = manualSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "invalid_body" });
  const { workspace_id: workspaceId, ad_account_id: accountId } = parsed.data;

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!member) return json(403, { error: "forbidden" });

  let query = admin
    .from("ad_accounts")
    .select(`${SYNC_ACCOUNT_COLUMNS}, last_synced_at`)
    .eq("workspace_id", workspaceId)
    .eq("platform", "meta")
    .eq("is_tracked", true)
    .neq("status", "disabled");
  if (accountId) query = query.eq("id", accountId);
  const { data: rows, error } = await query.order("last_synced_at", { ascending: true, nullsFirst: true });
  if (error) {
    log("error", "meta_sync_manual_lookup_failed", { error: error.message });
    return json(500, { error: "internal_error" });
  }
  // Conta nova (sem sincronização) ou pedida pelo id sempre vai; as demais respeitam o intervalo.
  const accounts = (rows ?? []).filter((a) => {
    const last = (a as { last_synced_at: string | null }).last_synced_at;
    return accountId || !last || Date.now() - new Date(last).getTime() > MANUAL_MIN_INTERVAL_MS;
  }) as SyncAccount[];

  if (accounts.length) {
    runInBackground(
      syncAll(accounts, deadline).then((results) =>
        log("info", "meta_sync_manual_done", { workspaceId, accounts: accounts.length, ...results })
      ),
    );
  }
  return json(202, { started: accounts.length });
});
