// Webhooks de venda: POST /functions/v1/webhooks/{provider}/{webhook_url_token}
//
// 1. Encontra a integração pelo token da URL e confere o provedor.
// 2. Valida a assinatura com o segredo guardado no Vault.
// 3. Grava o evento (sem dados pessoais) e responde 200 na hora.
// 4. Normaliza e grava a venda em segundo plano (EdgeRuntime.waitUntil).
//
// POST /functions/v1/webhooks/_process (Authorization: Bearer <service_role>) reprocessa pendentes.

import { getAdapter } from "../_shared/checkout/registry.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { errorMessage, log } from "../_shared/log.ts";
import { createAdminClient } from "../_shared/supabase-admin.ts";
import { processPendingEvents, processWebhookEvent } from "./process.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const MAX_BODY_BYTES = 1_000_000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function runInBackground(task: Promise<unknown>): void {
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(task);
  else task.catch((e) => log("error", "background_task_failed", { error: errorMessage(e) }));
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const base = segments.lastIndexOf("webhooks");
  const [provider, token] = segments.slice(base + 1);

  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const admin = createAdminClient();

  if (provider === "_process") {
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!serviceKey || !timingSafeEqual(auth, serviceKey)) return json(401, { error: "unauthorized" });
    const processed = await processPendingEvents(admin);
    return json(200, { processed });
  }

  const adapter = provider ? getAdapter(provider) : null;
  if (!adapter || !token || !TOKEN_PATTERN.test(token)) return json(404, { error: "not_found" });

  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });

  const { data: integration, error: lookupError } = await admin
    .from("checkout_integrations")
    .select("id, workspace_id, provider, active, webhook_secret_ref")
    .eq("webhook_url_token", token)
    .maybeSingle();

  if (lookupError) {
    log("error", "integration_lookup_failed", { requestId, error: lookupError.message });
    return json(500, { error: "internal_error" });
  }
  // Mesma resposta para token inexistente e provedor trocado: não revela tokens válidos.
  if (!integration || integration.provider !== adapter.provider) {
    log("warn", "webhook_unknown_token", { requestId, provider });
    return json(404, { error: "not_found" });
  }

  const baseEvent = {
    workspace_id: integration.workspace_id,
    checkout_integration_id: integration.id,
    provider: adapter.provider,
  };

  let secret: string | null = null;
  if (integration.webhook_secret_ref) {
    const { data, error } = await admin.rpc("service_read_secret", { p_secret_id: integration.webhook_secret_ref });
    if (error) {
      log("error", "secret_read_failed", { requestId, integrationId: integration.id, error: error.message });
      return json(500, { error: "internal_error" });
    }
    secret = (data as string | null) ?? null;
  }

  const verification =
    adapter.requiresSecret || secret
      ? await adapter.verify({ rawBody, url, headers: req.headers, secret })
      : ({ ok: true } as const);

  if (!verification.ok) {
    await admin.from("webhook_events").insert({
      ...baseEvent,
      status: "rejected",
      error: verification.reason,
      payload: { rejected: true, bytes: rawBody.length },
    });
    log("warn", "webhook_rejected", { requestId, integrationId: integration.id, reason: verification.reason });
    return json(401, { error: "invalid_signature" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await admin.from("webhook_events").insert({
      ...baseEvent,
      status: "rejected",
      error: "Corpo da requisição não é JSON válido.",
      payload: { rejected: true, bytes: rawBody.length },
    });
    return json(400, { error: "invalid_json" });
  }

  const redacted = await adapter.redact(payload);
  const summary = adapter.summarize(payload);

  if (!integration.active) {
    await admin.from("webhook_events").insert({
      ...baseEvent,
      status: "ignored",
      error: "Integração desativada no Nishiads.",
      event_type: summary.eventType,
      external_order_id: summary.externalOrderId,
      payload: redacted,
    });
    return json(200, { ok: true, ignored: true });
  }

  const { data: event, error: insertError } = await admin
    .from("webhook_events")
    .insert({
      ...baseEvent,
      status: "received",
      event_type: summary.eventType,
      external_order_id: summary.externalOrderId,
      payload: redacted,
    })
    .select("id")
    .single();

  if (insertError || !event) {
    log("error", "webhook_event_insert_failed", { requestId, error: insertError?.message });
    // 500 faz o provedor tentar de novo: nada se perde.
    return json(500, { error: "internal_error" });
  }

  await admin
    .from("checkout_integrations")
    .update({ last_event_at: new Date().toISOString() })
    .eq("id", integration.id);

  log("info", "webhook_received", {
    requestId,
    eventId: event.id,
    integrationId: integration.id,
    provider: adapter.provider,
    eventType: summary.eventType,
  });

  runInBackground(processWebhookEvent(admin, event.id as number));
  return json(200, { ok: true, event_id: event.id });
});
