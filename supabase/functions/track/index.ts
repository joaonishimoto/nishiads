/**
 * Eventos do script do Nishistack Ads (nishistack-ads.js) nos sites e apps rastreados.
 *
 * POST /functions/v1/track
 *   { key, event, id?, event_id, visitor, touch: { utm_*, fbclid, url, at } }
 *   Público (o script roda no navegador de qualquer visitante): a chave só identifica a
 *   fonte. O corpo vai como text/plain (sendBeacon), sem preflight de CORS.
 */
import { parseTrackBody } from "../_shared/tracking/event.ts";
import { errorMessage, log } from "../_shared/log.ts";
import { createAdminClient } from "../_shared/supabase-admin.ts";

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
      attribution_status?: string;
      duplicate?: boolean;
    };
    if (!result.ok) return json(404, { error: result.error ?? "unknown_key" });
    log("info", "tracking_event", {
      event: parsed.event.event,
      attribution: result.attribution_status ?? null,
      duplicate: !!result.duplicate,
    });
    return json(200, { ok: true });
  } catch (cause) {
    log("error", "tracking_event_failed", { error: errorMessage(cause) });
    return json(500, { error: "internal_error" });
  }
});
