/**
 * Conexão com a Meta Ads (Facebook Login).
 *
 * POST /functions/v1/meta-oauth   (Authorization: Bearer <access token do usuário>)
 *   { "action": "start", "workspace_id": "...", "return_to": "https://app/w/<id>/integracoes" } → { url }
 *   Só owner/admin. Devolve a URL do diálogo de login da Meta com um `state` de uso único.
 *
 * GET /functions/v1/meta-oauth/callback?code=...&state=...
 *   Retorno da Meta: troca o código por token, converte para longa duração, guarda no Vault,
 *   lista as contas de anúncio e volta para o app com ?meta=conectado (ou ?meta_erro=<motivo>).
 */
import { z } from "zod";
import { errorMessage, log } from "../_shared/log.ts";
import { FACEBOOK_DIALOG_URL, GraphClient, GRAPH_BASE_URL } from "../_shared/meta/graph.ts";
import { accountStatusFromMeta, normalizeAccountId } from "../_shared/meta/mapping.ts";
import { SYNC_ACCOUNT_COLUMNS, syncAdAccount, type SyncAccount } from "../_shared/meta/sync.ts";
import { createAdminClient } from "../_shared/supabase-admin.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const SCOPES = ["ads_read", "business_management"];

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

function config() {
  const appId = Deno.env.get("META_APP_ID")?.trim();
  const appSecret = Deno.env.get("META_APP_SECRET")?.trim();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  if (!appId || !appSecret || !supabaseUrl) return null;
  const appUrls = (Deno.env.get("APP_URL") ?? "https://nishiads.areadeteste.com,http://localhost:5173")
    .split(",")
    .map((u) => u.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return {
    appId,
    appSecret,
    // Facebook Login para Empresas usa uma configuração (config_id) no lugar de `scope`.
    configId: Deno.env.get("META_LOGIN_CONFIG_ID")?.trim() || null,
    redirectUri: `${supabaseUrl}/functions/v1/meta-oauth/callback`,
    appUrls,
  };
}

type Config = NonNullable<ReturnType<typeof config>>;

/** Só volta para o próprio app (evita open redirect). */
function allowedReturn(cfg: Config, value: string): string | null {
  try {
    const url = new URL(value);
    return cfg.appUrls.includes(url.origin) ? url.toString() : null;
  } catch {
    return null;
  }
}

function backTo(target: string, params: Record<string, string>): Response {
  const url = new URL(target);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: url.toString(), "cache-control": "no-store" } });
}

const startSchema = z.object({
  action: z.literal("start"),
  workspace_id: z.string().uuid(),
  return_to: z.string().url().max(500),
});

async function start(req: Request, cfg: Config): Promise<Response> {
  const admin = createAdminClient();
  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: auth, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !auth.user) return json(401, { error: "unauthorized" });

  const parsed = startSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "invalid_body" });
  const returnTo = allowedReturn(cfg, parsed.data.return_to);
  if (!returnTo) return json(400, { error: "invalid_return_to" });

  const { data: state, error } = await admin.rpc("service_create_meta_oauth_state", {
    p_workspace_id: parsed.data.workspace_id,
    p_user_id: auth.user.id,
    p_return_to: returnTo,
  });
  if (error) {
    if (error.code === "42501") return json(403, { error: "forbidden" });
    log("error", "meta_oauth_state_failed", { error: error.message });
    return json(500, { error: "internal_error" });
  }

  const url = new URL(FACEBOOK_DIALOG_URL);
  url.searchParams.set("client_id", cfg.appId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("state", state as string);
  url.searchParams.set("response_type", "code");
  if (cfg.configId) url.searchParams.set("config_id", cfg.configId);
  else url.searchParams.set("scope", SCOPES.join(","));
  return json(200, { url: url.toString() });
}

type TokenResponse = { access_token?: string; expires_in?: number; error?: { message?: string } };

async function exchange(params: Record<string, string>): Promise<TokenResponse> {
  const url = new URL(`${GRAPH_BASE_URL}/oauth/access_token`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) throw new Error(body.error?.message ?? `oauth HTTP ${res.status}`);
  return body;
}

type MetaAdAccount = {
  account_id: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  account_status?: number;
};

async function callback(url: URL, cfg: Config): Promise<Response> {
  const admin = createAdminClient();
  const fallback = `${cfg.appUrls[0]}/`;
  const stateParam = url.searchParams.get("state") ?? "";
  const { data: states } = /^[0-9a-f]{64}$/.test(stateParam)
    ? await admin.rpc("service_consume_meta_oauth_state", { p_state: stateParam })
    : { data: null };
  const state = (states as { workspace_id: string; user_id: string; return_to: string }[] | null)?.[0];
  if (!state) return backTo(fallback, { meta_erro: "sessao_expirada" });

  if (url.searchParams.get("error")) {
    // Usuário cancelou ou negou as permissões no diálogo da Meta.
    return backTo(state.return_to, { meta_erro: "cancelado" });
  }
  const code = url.searchParams.get("code");
  if (!code) return backTo(state.return_to, { meta_erro: "sem_codigo" });

  try {
    const short = await exchange({
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      redirect_uri: cfg.redirectUri,
      code,
    });
    const long = await exchange({
      grant_type: "fb_exchange_token",
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      fb_exchange_token: short.access_token!,
    });
    const token = long.access_token!;
    // Sem expires_in, o token não expira (ex.: usuário do sistema). Senão, ~60 dias.
    const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null;

    const graph = new GraphClient({ accessToken: token, appSecret: cfg.appSecret });
    const me = await graph.get<{ id: string; name?: string }>("me", { fields: "id,name" });
    const permissions = await graph.get<{ data: { permission: string; status: string }[] }>("me/permissions");
    const granted = permissions.data.filter((p) => p.status === "granted").map((p) => p.permission);
    if (!granted.includes("ads_read")) return backTo(state.return_to, { meta_erro: "sem_permissao" });

    const { data: connectionId, error: upsertError } = await admin.rpc("service_upsert_meta_connection", {
      p_workspace_id: state.workspace_id,
      p_user_id: state.user_id,
      p_meta_user_id: me.id,
      p_meta_user_name: me.name ?? null,
      p_token: token,
      p_token_expires_at: expiresAt,
      p_scopes: granted,
    });
    if (upsertError) throw new Error(upsertError.message);

    const accounts: MetaAdAccount[] = [];
    for await (const page of graph.paginate<MetaAdAccount>("me/adaccounts", {
      fields: "account_id,name,currency,timezone_name,account_status",
      limit: 200,
    })) {
      accounts.push(...page);
    }

    if (accounts.length) {
      // is_tracked não entra: conta nova começa desligada; a já escolhida continua escolhida.
      const { error } = await admin.from("ad_accounts").upsert(
        accounts.map((a) => ({
          workspace_id: state.workspace_id,
          platform: "meta",
          external_id: normalizeAccountId(a.account_id),
          name: a.name || `Conta ${a.account_id}`,
          currency: (a.currency || "BRL").toUpperCase(),
          timezone: a.timezone_name ?? null,
          status: accountStatusFromMeta(a.account_status),
          meta_connection_id: connectionId,
          token_expires_at: expiresAt,
          last_sync_error: null,
          connected_by: state.user_id,
        })),
        { onConflict: "workspace_id,platform,external_id" },
      );
      if (error) throw new Error(error.message);
    }
    log("info", "meta_connected", { workspaceId: state.workspace_id, accounts: accounts.length });

    // Reconexão: as contas já acompanhadas voltam a sincronizar agora, em segundo plano.
    const { data: tracked } = await admin
      .from("ad_accounts")
      .select(SYNC_ACCOUNT_COLUMNS)
      .eq("meta_connection_id", connectionId)
      .eq("is_tracked", true)
      .neq("status", "disabled");
    if (tracked?.length) {
      const appSecret = cfg.appSecret;
      const task = (async () => {
        const deadline = Date.now() + 130_000;
        for (const account of tracked as SyncAccount[]) {
          if (Date.now() > deadline) break;
          await syncAdAccount(admin, account, { deadline, appSecret });
        }
      })();
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(task);
    }

    return backTo(state.return_to, { meta: "conectado", contas: String(accounts.length) });
  } catch (cause) {
    log("error", "meta_oauth_callback_failed", { workspaceId: state.workspace_id, error: errorMessage(cause) });
    return backTo(state.return_to, { meta_erro: "falha" });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const cfg = config();
  const url = new URL(req.url);
  const isCallback = url.pathname.endsWith("/callback");

  if (!cfg) {
    log("error", "meta_oauth_not_configured");
    return isCallback
      ? new Response("Conexão com a Meta não configurada (META_APP_ID / META_APP_SECRET).", { status: 503 })
      : json(503, { error: "meta_not_configured" });
  }
  if (isCallback && req.method === "GET") return callback(url, cfg);
  if (!isCallback && req.method === "POST") return start(req, cfg);
  return json(405, { error: "method_not_allowed" });
});
