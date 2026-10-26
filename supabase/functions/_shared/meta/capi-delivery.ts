/**
 * Envio da fila meta_capi_events (preenchida pelo trigger de vendas).
 * Chamado logo depois do webhook (só os eventos da venda) e pelo pg_cron (retentativas).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage, log } from "../log.ts";
import {
  buildServerEvent,
  buildTestEvent,
  CAPI_MAX_AGE_MS,
  friendlyCapiError,
  retryDelaySeconds,
  sendServerEvent,
  type CapiCredentials,
  type CapiEventRow,
  type CapiSale,
  type SendOutcome,
} from "./capi.ts";

const SALE_COLUMNS =
  "id, external_order_id, gross_amount_cents, currency, external_product_id, product_name, " +
  "customer_email_hash, fbc, fbp, client_user_agent, raw_payload";

export interface DeliveryOptions {
  saleId?: string;
  eventId?: number;
  workspaceId?: string;
  limit?: number;
  /** Date.now() limite para começar um envio. */
  deadline?: number;
  fetchFn?: typeof fetch;
}

export type DeliverySummary = {
  sent: number;
  failed: number;
  retrying: number;
  skipped: number;
  deferred: number;
};

async function credentialsFor(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<CapiCredentials | null> {
  const { data, error } = await admin.rpc("service_meta_capi_credentials", {
    p_workspace_id: workspaceId,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as CapiCredentials | undefined;
  return row?.access_token ? row : null;
}

async function update(admin: SupabaseClient, id: number, patch: Record<string, unknown>) {
  const { error } = await admin
    .from("meta_capi_events")
    .update({ locked_until: null, ...patch })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

async function release(admin: SupabaseClient, ids: number[]) {
  if (ids.length) await admin.from("meta_capi_events").update({ locked_until: null }).in("id", ids);
}

async function markConfig(
  admin: SupabaseClient,
  workspaceId: string,
  patch: Record<string, unknown>,
) {
  await admin.from("meta_capi_configs").update(patch).eq("workspace_id", workspaceId);
}

/** Envia os eventos vencidos. Nunca lança por um evento: cada falha fica registrada nele. */
export async function deliverDueEvents(
  admin: SupabaseClient,
  options: DeliveryOptions = {},
): Promise<DeliverySummary> {
  const summary: DeliverySummary = { sent: 0, failed: 0, retrying: 0, skipped: 0, deferred: 0 };
  const { data, error } = await admin.rpc("service_claim_meta_capi_events", {
    p_limit: options.limit ?? 50,
    p_sale_id: options.saleId ?? null,
    p_event_id: options.eventId ?? null,
    p_workspace_id: options.workspaceId ?? null,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as CapiEventRow[];
  if (!rows.length) return summary;

  const credentials = new Map<string, CapiCredentials | null>();
  /** Workspaces com token/pixel com problema nesta execução: o resto espera a próxima. */
  const blocked = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if ((options.deadline && Date.now() > options.deadline) || blocked.has(row.workspace_id)) {
      summary.deferred++;
      await release(admin, [row.id]);
      continue;
    }
    try {
      if (!credentials.has(row.workspace_id)) {
        credentials.set(row.workspace_id, await credentialsFor(admin, row.workspace_id));
      }
      const creds = credentials.get(row.workspace_id);
      if (!creds) {
        summary.deferred++;
        await release(admin, [row.id]);
        continue;
      }
      const { result, configError } = await deliverOne(admin, row, creds, options.fetchFn);
      summary[result]++;
      if (configError) blocked.add(row.workspace_id);
    } catch (cause) {
      // Erro nosso (banco): solta o evento para a próxima execução.
      log("error", "meta_capi_delivery_failed", { eventId: row.id, error: errorMessage(cause) });
      summary.deferred++;
      await release(admin, [row.id]).catch(() => undefined);
    }
  }
  log("info", "meta_capi_delivery_done", { claimed: rows.length, ...summary });
  return summary;
}

type DeliverResult = {
  result: "sent" | "failed" | "retrying" | "skipped";
  /** Token/pixel com problema: os outros eventos do workspace esperam a correção. */
  configError: boolean;
};

async function deliverOne(
  admin: SupabaseClient,
  row: CapiEventRow,
  creds: CapiCredentials,
  fetchFn?: typeof fetch,
): Promise<DeliverResult> {
  if (!row.sale_id) {
    await update(admin, row.id, { status: "skipped", last_error: "Evento sem venda." });
    return { result: "skipped", configError: false };
  }
  const { data: sale, error } = await admin
    .from("sales")
    .select(SALE_COLUMNS)
    .eq("id", row.sale_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!sale) {
    await update(admin, row.id, { status: "skipped", last_error: "Venda não existe mais." });
    return { result: "skipped", configError: false };
  }

  let built = await buildServerEvent(row, sale as unknown as CapiSale, creds);
  if (built.kind === "skip") {
    await update(admin, row.id, { status: "skipped", last_error: built.reason });
    return { result: "skipped", configError: false };
  }
  let outcome: SendOutcome = await sendServerEvent(creds, built.event, fetchFn);
  // Evento de site sem user agent recusado: vai como "other", que não exige.
  if (!outcome.ok && outcome.needsUserAgent && built.event.action_source === "website") {
    built = await buildServerEvent(row, sale as unknown as CapiSale, creds, {
      actionSource: "other",
    });
    if (built.kind === "event") outcome = await sendServerEvent(creds, built.event, fetchFn);
  }
  const event = built.kind === "event" ? built.event : null;
  const request = { event, test_event_code: creds.test_event_code };
  const attempts = row.attempts + 1;

  if (outcome.ok) {
    await update(admin, row.id, {
      status: "sent",
      attempts,
      sent_at: new Date().toISOString(),
      last_error: null,
      request,
      response: outcome.response,
    });
    await markConfig(admin, row.workspace_id, {
      last_sent_at: new Date().toISOString(),
      last_error: null,
      last_error_at: null,
    });
    log("info", "meta_capi_event_sent", {
      eventId: row.id,
      workspaceId: row.workspace_id,
      name: row.event_name,
    });
    return { result: "sent", configError: false };
  }

  const message = friendlyCapiError(outcome);
  let delay = retryDelaySeconds(outcome.kind, attempts);
  // Não adianta reagendar para depois do limite de 7 dias da Meta.
  if (delay !== null && Date.parse(row.event_time) + CAPI_MAX_AGE_MS < Date.now() + delay * 1000)
    delay = null;

  await update(admin, row.id, {
    status: delay === null ? "failed" : "pending",
    attempts,
    next_attempt_at: new Date(Date.now() + (delay ?? 0) * 1000).toISOString(),
    last_error: message,
    request,
    response: outcome.response,
  });
  if (outcome.kind === "config") {
    await markConfig(admin, row.workspace_id, {
      last_error: message,
      last_error_at: new Date().toISOString(),
    });
  }
  log("warn", "meta_capi_event_failed", {
    eventId: row.id,
    workspaceId: row.workspace_id,
    kind: outcome.kind,
    code: outcome.code,
    subcode: outcome.subcode,
    retryInSeconds: delay,
  });
  return { result: delay === null ? "failed" : "retrying", configError: outcome.kind === "config" };
}

export type TestOutcome =
  | { ok: true; events_received: number | null; fbtrace_id: string | null }
  | { ok: false; error: string };

/** Botão "Enviar evento de teste": exige código de teste, para não sujar os dados reais. */
export async function sendTestEvent(
  admin: SupabaseClient,
  workspaceId: string,
  fetchFn?: typeof fetch,
): Promise<TestOutcome | { ok: false; error: "not_configured" | "test_code_required" }> {
  const creds = await credentialsFor(admin, workspaceId);
  if (!creds) return { ok: false, error: "not_configured" };
  if (!creds.test_event_code) return { ok: false, error: "test_code_required" };

  const event = await buildTestEvent(creds);
  const outcome = await sendServerEvent(creds, event, fetchFn);
  const now = new Date().toISOString();
  await admin.from("meta_capi_events").insert({
    workspace_id: workspaceId,
    sale_id: null,
    event_name: event.event_name,
    event_id: event.event_id,
    event_time: new Date(event.event_time * 1000).toISOString(),
    is_test: true,
    status: outcome.ok ? "sent" : "failed",
    attempts: 1,
    sent_at: outcome.ok ? now : null,
    last_error: outcome.ok ? null : friendlyCapiError(outcome),
    request: { event, test_event_code: creds.test_event_code },
    response: outcome.response,
  });
  if (outcome.ok) {
    await markConfig(admin, workspaceId, { last_error: null, last_error_at: null });
    const received = outcome.response.events_received;
    const trace = outcome.response.fbtrace_id;
    return {
      ok: true,
      events_received: typeof received === "number" ? received : null,
      fbtrace_id: typeof trace === "string" ? trace : null,
    };
  }
  const message = friendlyCapiError(outcome);
  if (outcome.kind === "config")
    await markConfig(admin, workspaceId, { last_error: message, last_error_at: now });
  return { ok: false, error: message };
}
