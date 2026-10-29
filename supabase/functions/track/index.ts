/**
 * Eventos do script do Nishistack Ads (nishistack-ads.js) nos sites e apps rastreados.
 *
 * POST /functions/v1/track
 *   { key, event, id?, event_id, visitor, touch: { utm_*, fbclid, url, at } }
 *   Público (o script roda no navegador de qualquer visitante): a chave só identifica a
 *   fonte. O corpo vai como text/plain (sendBeacon), sem preflight de CORS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseTrackBody } from "../_shared/tracking/event.ts";
import { trackedRegistrationPayload } from "../_shared/tracking/messages.ts";
import { errorMessage, log } from "../_shared/log.ts";
import { deliverPush } from "../_shared/notify/sale-notifications.ts";
import { vapidFromEnv } from "../_shared/notify/vapid.ts";
import { createAdminClient } from "../_shared/supabase-admin.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
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

/** Push na hora para cada cadastro novo, com o criativo de origem (preferência "Cadastros"). */
async function notifyRegistration(admin: SupabaseClient, eventId: number) {
  const vapid = vapidFromEnv();
  if (!vapid) return;
  try {
    const { data: event, error } = await admin
      .from("tracking_events")
      .select(
        "id, workspace_id, utm_source, utm_content, source:tracking_sources(name), campaign:campaigns(name), ad:ads(name)",
      )
      .eq("id", eventId)
      .single();
    if (error || !event) throw new Error(error?.message ?? "Evento não encontrado.");
    const { data: recipients, error: recipientsError } = await admin.rpc(
      "service_notification_recipients",
      {
        p_workspace_id: event.workspace_id,
        p_kind: "tracked_registration",
        p_amount_cents: 0,
      },
    );
    if (recipientsError) throw new Error(recipientsError.message);
    const list = recipients ?? [];
    if (!list.length) return;
    const one = <T>(value: T | T[] | null): T | null =>
      Array.isArray(value) ? (value[0] ?? null) : value;
    const payload = trackedRegistrationPayload({
      id: event.id,
      workspace_id: event.workspace_id,
      source_name:
        one(event.source as { name: string } | { name: string }[] | null)?.name ?? "Site",
      campaign_name:
        one(event.campaign as { name: string } | { name: string }[] | null)?.name ?? null,
      ad_name: one(event.ad as { name: string } | { name: string }[] | null)?.name ?? null,
      utm_content: event.utm_content,
      utm_source: event.utm_source,
    });
    const delivered = await deliverPush(admin, list, payload, vapid);
    log("info", "tracked_registration_notified", { eventId, recipients: list.length, delivered });
  } catch (cause) {
    log("warn", "tracked_registration_notify_failed", { eventId, error: errorMessage(cause) });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const parsed = parseTrackBody(await req.text());
  if (!parsed.ok) return json(400, { error: parsed.error });

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("service_track_event", {
      p_public_key: parsed.key,
      p_event: parsed.event,
    });
    if (error) throw new Error(error.message);
    const result = data as {
      ok: boolean;
      error?: string;
      event_id?: number;
      attribution_status?: string;
      duplicate?: boolean;
    };
    if (!result.ok) return json(404, { error: result.error ?? "unknown_key" });
    log("info", "tracking_event", {
      event: parsed.event.event,
      attribution: result.attribution_status ?? null,
      duplicate: !!result.duplicate,
    });
    if (parsed.event.event === "cadastro" && result.event_id) {
      runInBackground(notifyRegistration(admin, result.event_id));
    }
    return json(200, { ok: true });
  } catch (cause) {
    log("error", "tracking_event_failed", { error: errorMessage(cause) });
    return json(500, { error: "internal_error" });
  }
});
