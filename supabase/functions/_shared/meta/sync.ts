/**
 * Sincronização de uma conta de anúncio: dados da conta, estrutura
 * (campanhas › conjuntos › anúncios com thumbnail) e insights diários em level=ad.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage, log } from "../log.ts";
import { registrationsPushPayload, type RegistrationsByAd } from "../notify/messages.ts";
import { deliverPush } from "../notify/sale-notifications.ts";
import { vapidFromEnv } from "../notify/vapid.ts";
import { GraphClient, MetaApiError, type Usage } from "./graph.ts";
import {
  accountStatusFromMeta,
  budgetToCents,
  dateChunks,
  INSIGHT_FIELDS,
  insightsWindow,
  mapInsight,
  type MetaInsightRow,
} from "./mapping.ts";

export type SyncAccount = {
  id: string;
  workspace_id: string;
  external_id: string;
  currency: string;
  timezone: string | null;
  backfilled_at: string | null;
  meta_connection_id: string | null;
  rate_limited_until: string | null;
};

export const SYNC_ACCOUNT_COLUMNS =
  "id, workspace_id, external_id, currency, timezone, backfilled_at, meta_connection_id, rate_limited_until";

export type SyncOutcome =
  | { status: "ok"; campaigns: number; adsets: number; ads: number; insights: number; backfill: boolean }
  | { status: "skipped"; reason: "busy" | "rate_limited" }
  | { status: "needs_reconnect" | "rate_limited" | "error" | "timeout"; error: string };

class DeadlineError extends Error {}
class UsageLimitError extends Error {
  constructor(readonly regainSeconds: number) {
    super("Uso da API da Meta acima de 90%.");
  }
}

const BATCH = 500;
/** Acima disso, para a conta antes de a Meta bloquear. */
const USAGE_STOP_PERCENT = 90;
/** Acima disso, espera um pouco entre chamadas. */
const USAGE_SLOW_PERCENT = 75;

type Ctx = {
  admin: SupabaseClient;
  account: SyncAccount;
  graph: GraphClient;
  deadline: number;
  usage: Usage;
};

function checkDeadline(ctx: Ctx) {
  if (Date.now() > ctx.deadline) throw new DeadlineError("Tempo da execução esgotado.");
}

async function pace(ctx: Ctx) {
  checkDeadline(ctx);
  if (ctx.usage.maxPercent >= USAGE_STOP_PERCENT) throw new UsageLimitError(ctx.usage.regainSeconds);
  if (ctx.usage.maxPercent >= USAGE_SLOW_PERCENT) await new Promise((r) => setTimeout(r, 1500));
}

function chunk<T>(items: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Upsert em lotes; devolve external_id → id. */
async function upsertMap(
  admin: SupabaseClient,
  table: "campaigns" | "adsets" | "ads",
  rows: Record<string, unknown>[],
  ignoreDuplicates = false,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const part of chunk(rows)) {
    const { data, error } = await admin
      .from(table)
      .upsert(part, { onConflict: "ad_account_id,external_id", ignoreDuplicates })
      .select("id, external_id");
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of data ?? []) map.set(r.external_id as string, r.id as string);
  }
  return map;
}

async function loadMap(admin: SupabaseClient, table: "campaigns" | "adsets" | "ads", accountId: string, externalIds: string[]) {
  const map = new Map<string, string>();
  for (const part of chunk(externalIds, 200)) {
    const { data, error } = await admin.from(table).select("id, external_id").eq("ad_account_id", accountId).in("external_id", part);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of data ?? []) map.set(r.external_id as string, r.id as string);
  }
  return map;
}

type Status = { status?: string; effective_status?: string };
type Budget = { daily_budget?: string; lifetime_budget?: string };
type MetaCampaign = Status & Budget & { id: string; name: string; objective?: string };
type MetaAdset = Status & Budget & { id: string; name: string; campaign_id: string };
type MetaAd = Status & {
  id: string;
  name: string;
  adset_id: string;
  campaign_id: string;
  preview_shareable_link?: string;
  creative?: { id?: string; thumbnail_url?: string };
};

async function collect<T>(ctx: Ctx, path: string, params: Record<string, string | number>): Promise<T[]> {
  const all: T[] = [];
  for await (const page of ctx.graph.paginate<T>(path, { limit: 200, ...params })) {
    all.push(...page);
    await pace(ctx);
  }
  return all;
}

/** Garante campanha/conjunto/anúncio vistos só nos insights (ex.: arquivados). */
async function ensureFromInsights(
  ctx: Ctx,
  rows: MetaInsightRow[],
  campaigns: Map<string, string>,
  adsets: Map<string, string>,
  ads: Map<string, string>,
) {
  const base = { workspace_id: ctx.account.workspace_id, ad_account_id: ctx.account.id };
  const missing = <K extends "campaign_id" | "adset_id" | "ad_id">(key: K, map: Map<string, string>) => {
    const seen = new Map<string, MetaInsightRow>();
    for (const r of rows) if (r[key] && !map.has(r[key]) && !seen.has(r[key])) seen.set(r[key], r);
    return [...seen.values()];
  };

  const newCampaigns = missing("campaign_id", campaigns);
  if (newCampaigns.length) {
    await upsertMap(ctx.admin, "campaigns", newCampaigns.map((r) => ({
      ...base, external_id: r.campaign_id, name: r.campaign_name || `Campanha ${r.campaign_id}`,
    })), true);
    for (const [k, v] of await loadMap(ctx.admin, "campaigns", ctx.account.id, newCampaigns.map((r) => r.campaign_id))) campaigns.set(k, v);
  }
  const newAdsets = missing("adset_id", adsets);
  if (newAdsets.length) {
    await upsertMap(ctx.admin, "adsets", newAdsets.map((r) => ({
      ...base, campaign_id: campaigns.get(r.campaign_id), external_id: r.adset_id, name: r.adset_name || `Conjunto ${r.adset_id}`,
    })), true);
    for (const [k, v] of await loadMap(ctx.admin, "adsets", ctx.account.id, newAdsets.map((r) => r.adset_id))) adsets.set(k, v);
  }
  const newAds = missing("ad_id", ads);
  if (newAds.length) {
    await upsertMap(ctx.admin, "ads", newAds.map((r) => ({
      ...base,
      campaign_id: campaigns.get(r.campaign_id),
      adset_id: adsets.get(r.adset_id),
      external_id: r.ad_id,
      name: r.ad_name || `Anúncio ${r.ad_id}`,
    })), true);
    for (const [k, v] of await loadMap(ctx.admin, "ads", ctx.account.id, newAds.map((r) => r.ad_id))) ads.set(k, v);
  }
}

async function run(ctx: Ctx) {
  const { admin, account, graph } = ctx;
  const act = `act_${account.external_id}`;
  const base = { workspace_id: account.workspace_id, ad_account_id: account.id };

  // 1. Conta
  const info = await graph.get<{ name?: string; currency?: string; timezone_name?: string; account_status?: number }>(act, {
    fields: "name,currency,timezone_name,account_status",
  });
  const timezone = info.timezone_name ?? account.timezone;
  const currency = info.currency ?? account.currency;
  await admin
    .from("ad_accounts")
    .update({ name: info.name, currency, timezone, status: accountStatusFromMeta(info.account_status) })
    .eq("id", account.id);
  await pace(ctx);

  // 2. Estrutura
  const metaCampaigns = await collect<MetaCampaign>(ctx, `${act}/campaigns`, {
    fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget",
  });
  const campaigns = await upsertMap(admin, "campaigns", metaCampaigns.map((c) => ({
    ...base, external_id: c.id, name: c.name, status: c.status ?? null, effective_status: c.effective_status ?? null,
    objective: c.objective ?? null,
    daily_budget_cents: budgetToCents(c.daily_budget, currency),
    lifetime_budget_cents: budgetToCents(c.lifetime_budget, currency),
  })));

  const metaAdsets = await collect<MetaAdset>(ctx, `${act}/adsets`, {
    fields: "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget",
  });
  // Pai fora da lista (ex.: campanha arquivada): cria um registro mínimo para não perder o filho.
  const orphanCampaigns = [...new Set(metaAdsets.map((a) => a.campaign_id).filter((id) => !campaigns.has(id)))];
  if (orphanCampaigns.length) {
    await upsertMap(admin, "campaigns", orphanCampaigns.map((id) => ({ ...base, external_id: id, name: `Campanha ${id}` })), true);
    for (const [k, v] of await loadMap(admin, "campaigns", account.id, orphanCampaigns)) campaigns.set(k, v);
  }
  const adsets = await upsertMap(admin, "adsets", metaAdsets.map((a) => ({
    ...base, campaign_id: campaigns.get(a.campaign_id), external_id: a.id, name: a.name, status: a.status ?? null,
    effective_status: a.effective_status ?? null,
    daily_budget_cents: budgetToCents(a.daily_budget, currency),
    lifetime_budget_cents: budgetToCents(a.lifetime_budget, currency),
  })));

  const adFields = "id,name,status,effective_status,adset_id,campaign_id,preview_shareable_link,";
  let metaAds: MetaAd[];
  try {
    // Thumbnail maior que o padrão (64px), para a linha do anúncio no dashboard.
    metaAds = await collect<MetaAd>(ctx, `${act}/ads`, {
      fields: adFields + "creative.thumbnail_width(320).thumbnail_height(320){id,thumbnail_url}",
    });
  } catch (cause) {
    if (!(cause instanceof MetaApiError) || cause.kind !== "other") throw cause;
    log("warn", "meta_ads_thumbnail_fallback", { accountId: account.id, error: cause.message });
    metaAds = await collect<MetaAd>(ctx, `${act}/ads`, { fields: adFields + "creative{id,thumbnail_url}" });
  }
  const usableAds = metaAds.filter((a) => campaigns.has(a.campaign_id) && adsets.has(a.adset_id));
  const ads = await upsertMap(admin, "ads", usableAds.map((a) => ({
    ...base,
    campaign_id: campaigns.get(a.campaign_id),
    adset_id: adsets.get(a.adset_id),
    external_id: a.id,
    name: a.name,
    status: a.status ?? null,
    effective_status: a.effective_status ?? null,
    creative_id: a.creative?.id ?? null,
    thumbnail_url: a.creative?.thumbnail_url ?? null,
    preview_link: a.preview_shareable_link ?? null,
  })));

  // 3. Insights por anúncio e por dia (backfill de 30 dias na primeira vez; depois, 3 dias)
  const window = insightsWindow({ timezone, backfilled_at: account.backfilled_at });
  let insights = 0;
  // Cadastros a mais que a Meta atribuiu a cada anúncio nesta sincronização (por id interno).
  const newRegistrations = new Map<string, RegistrationsByAd>();
  for (const range of dateChunks(window.since, window.until)) {
    const pages = graph.paginate<MetaInsightRow>(`${act}/insights`, {
      level: "ad",
      time_increment: 1,
      time_range: JSON.stringify(range),
      fields: INSIGHT_FIELDS,
      limit: 500,
    });
    for await (const rows of pages) {
      await ensureFromInsights(ctx, rows, campaigns, adsets, ads);
      const values = rows
        .filter((r) => ads.has(r.ad_id))
        .map((r) => ({
          ...base,
          ad_id: ads.get(r.ad_id),
          ...mapInsight(r, currency),
          synced_at: new Date().toISOString(),
        }));
      const names = new Map(rows.map((r) => [ads.get(r.ad_id), { campaign_name: r.campaign_name ?? null, ad_name: r.ad_name ?? null }]));
      for (const part of chunk(values)) {
        if (!window.backfill) await countNewRegistrations(admin, part, names, newRegistrations);
        const { error } = await admin.from("ad_insights_daily").upsert(part, { onConflict: "ad_id,date" });
        if (error) throw new Error(`ad_insights_daily: ${error.message}`);
      }
      insights += values.length;
      await pace(ctx);
    }
  }

  const now = new Date().toISOString();
  await admin
    .from("ad_accounts")
    .update({
      last_synced_at: now,
      last_sync_error: null,
      rate_limited_until: null,
      ...(window.backfill ? { backfilled_at: now } : {}),
    })
    .eq("id", account.id);

  if (newRegistrations.size) await notifyRegistrations(admin, account.workspace_id, [...newRegistrations.values()]);

  // Vendas que chegaram antes da sincronização agora podem casar com os ids.
  const { error: reattributeError } = await admin.rpc("service_reattribute_sales", { p_workspace_id: account.workspace_id });
  if (reattributeError) log("warn", "meta_reattribute_failed", { accountId: account.id, error: reattributeError.message });

  return { campaigns: campaigns.size, adsets: adsets.size, ads: ads.size, insights, backfill: window.backfill };
}

/** Soma, por anúncio, quanto os cadastros subiram em relação ao que já estava salvo. */
async function countNewRegistrations(
  admin: SupabaseClient,
  part: { ad_id: string | undefined; date: string; registrations: number }[],
  names: Map<string | undefined, { campaign_name: string | null; ad_name: string | null }>,
  into: Map<string, RegistrationsByAd>,
) {
  const adIds = [...new Set(part.map((v) => v.ad_id).filter((id): id is string => !!id))];
  const dates = [...new Set(part.map((v) => v.date))];
  if (!adIds.length) return;
  const { data, error } = await admin
    .from("ad_insights_daily")
    .select("ad_id, date, registrations")
    .in("ad_id", adIds)
    .in("date", dates);
  if (error) {
    log("warn", "meta_registrations_lookup_failed", { error: error.message });
    return;
  }
  const previous = new Map((data ?? []).map((r) => [`${r.ad_id}:${r.date}`, Number(r.registrations) || 0]));
  for (const v of part) {
    if (!v.ad_id) continue;
    const delta = v.registrations - (previous.get(`${v.ad_id}:${v.date}`) ?? 0);
    if (delta <= 0) continue;
    const entry = into.get(v.ad_id) ?? { ...(names.get(v.ad_id) ?? { campaign_name: null, ad_name: null }), count: 0 };
    entry.count += delta;
    into.set(v.ad_id, entry);
  }
}

/** Avisa quem ligou "Cadastros" nas preferências (respeitando o horário de silêncio). */
async function notifyRegistrations(admin: SupabaseClient, workspaceId: string, ads: RegistrationsByAd[]) {
  const vapid = vapidFromEnv();
  if (!vapid) return;
  try {
    const { data: recipients, error } = await admin.rpc("service_notification_recipients", {
      p_workspace_id: workspaceId,
      p_kind: "registration",
      p_amount_cents: 0,
    });
    if (error) throw new Error(error.message);
    const list = recipients ?? [];
    const delivered = list.length
      ? await deliverPush(admin, list, registrationsPushPayload(workspaceId, ads, new Date().toISOString()), vapid)
      : 0;
    log("info", "registrations_notified", {
      workspaceId,
      registrations: ads.reduce((n, a) => n + a.count, 0),
      recipients: list.length,
      delivered,
    });
  } catch (cause) {
    log("warn", "registrations_notify_failed", { workspaceId, error: errorMessage(cause) });
  }
}

/** Marca a conexão e as contas como "reconectar" e avisa owners/admins (uma vez). */
export async function markNeedsReconnect(admin: SupabaseClient, connectionId: string, reason: string) {
  const { data: changed } = await admin
    .from("meta_connections")
    .update({ status: "needs_reconnect", last_error: reason })
    .eq("id", connectionId)
    .eq("status", "active")
    .select("workspace_id, meta_user_name");
  await admin
    .from("ad_accounts")
    .update({ status: "needs_reconnect", last_sync_error: "Reconecte a Meta para voltar a sincronizar." })
    .eq("meta_connection_id", connectionId);
  const connection = changed?.[0] as { workspace_id: string; meta_user_name: string | null } | undefined;
  if (connection) await notifyReconnect(admin, connection.workspace_id, connection.meta_user_name);
}

async function notifyReconnect(admin: SupabaseClient, workspaceId: string, metaUserName: string | null) {
  const vapid = vapidFromEnv();
  if (!vapid) return;
  try {
    const { data: managers } = await admin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .in("role", ["owner", "admin"]);
    const userIds = (managers ?? []).map((m) => m.user_id as string);
    if (!userIds.length) return;
    const { data: subs } = await admin
      .from("notification_subscriptions")
      .select("id, user_id, endpoint, config")
      .eq("workspace_id", workspaceId)
      .eq("channel", "webpush")
      .eq("active", true)
      .in("user_id", userIds);
    const recipients = (subs ?? []).map((s) => ({
      subscription_id: s.id as string,
      user_id: s.user_id as string,
      endpoint: s.endpoint as string,
      config: s.config as { p256dh?: string; auth?: string },
      sound_enabled: true,
    }));
    if (!recipients.length) return;
    await deliverPush(admin, recipients, {
      title: "⚠️ Reconecte a Meta Ads",
      body: `O acesso${metaUserName ? ` de ${metaUserName}` : ""} expirou. Sem reconectar, gastos e criativos param de atualizar.`,
      url: `/w/${workspaceId}/integracoes`,
      tag: `meta-reconnect-${workspaceId}`,
    }, vapid);
  } catch (cause) {
    log("warn", "meta_reconnect_notify_failed", { workspaceId, error: errorMessage(cause) });
  }
}

/** Sincroniza uma conta com trava, tratamento de erros da Meta e registro do resultado. */
export async function syncAdAccount(
  admin: SupabaseClient,
  account: SyncAccount,
  options: { deadline: number; appSecret: string | null },
): Promise<SyncOutcome> {
  if (account.rate_limited_until && new Date(account.rate_limited_until).getTime() > Date.now()) {
    return { status: "skipped", reason: "rate_limited" };
  }
  const { data: claimed, error: claimError } = await admin.rpc("service_claim_ad_account_sync", { p_ad_account_id: account.id });
  if (claimError) return { status: "error", error: claimError.message };
  if (!claimed) return { status: "skipped", reason: "busy" };

  const started = Date.now();
  try {
    const { data: connection } = account.meta_connection_id
      ? await admin.from("meta_connections").select("id, status, token_ref").eq("id", account.meta_connection_id).maybeSingle()
      : { data: null };
    if (!connection || connection.status !== "active" || !connection.token_ref) {
      await admin
        .from("ad_accounts")
        .update({ status: "needs_reconnect", last_sync_error: "Reconecte a Meta para voltar a sincronizar." })
        .eq("id", account.id);
      return { status: "needs_reconnect", error: "Conexão com a Meta ausente ou expirada." };
    }
    const { data: token, error: tokenError } = await admin.rpc("service_read_secret", { p_secret_id: connection.token_ref });
    if (tokenError || !token) throw new Error(tokenError?.message ?? "Token da Meta não encontrado no Vault.");

    const ctx: Ctx = {
      admin,
      account,
      deadline: options.deadline,
      usage: { maxPercent: 0, regainSeconds: 0 },
      graph: undefined as unknown as GraphClient,
    };
    ctx.graph = new GraphClient({
      accessToken: token as string,
      appSecret: options.appSecret,
      onUsage: (u) => (ctx.usage = u),
    });

    const result = await run(ctx);
    log("info", "meta_sync_ok", { accountId: account.id, ms: Date.now() - started, ...result });
    return { status: "ok", ...result };
  } catch (cause) {
    const message = errorMessage(cause);
    if (cause instanceof MetaApiError && cause.kind === "token") {
      if (account.meta_connection_id) await markNeedsReconnect(admin, account.meta_connection_id, message);
      log("warn", "meta_sync_token_invalid", { accountId: account.id, code: cause.code, subcode: cause.subcode });
      return { status: "needs_reconnect", error: message };
    }
    if ((cause instanceof MetaApiError && cause.kind === "rate_limit") || cause instanceof UsageLimitError) {
      const seconds = Math.max(cause instanceof UsageLimitError ? cause.regainSeconds : (cause.retryAfterSeconds ?? 0), 600);
      const until = new Date(Date.now() + seconds * 1000);
      const hhmm = until.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
      await admin
        .from("ad_accounts")
        .update({
          rate_limited_until: until.toISOString(),
          last_sync_error: `Limite de chamadas da Meta atingido. Nova tentativa depois das ${hhmm}.`,
        })
        .eq("id", account.id);
      log("warn", "meta_sync_rate_limited", { accountId: account.id, until: until.toISOString() });
      return { status: "rate_limited", error: message };
    }
    if (cause instanceof DeadlineError) {
      log("warn", "meta_sync_timeout", { accountId: account.id, ms: Date.now() - started });
      return { status: "timeout", error: message };
    }
    const permission = cause instanceof MetaApiError && cause.kind === "permission";
    await admin
      .from("ad_accounts")
      .update({
        last_sync_error: permission ? `Sem permissão na conta: ${message}` : message.slice(0, 500),
        ...(permission ? { status: "error" } : {}),
      })
      .eq("id", account.id);
    log("error", "meta_sync_failed", { accountId: account.id, error: message });
    return { status: "error", error: message };
  } finally {
    await admin.from("ad_accounts").update({ sync_started_at: null }).eq("id", account.id);
  }
}
