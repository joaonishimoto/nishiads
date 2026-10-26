/**
 * Conversions API da Meta: envio da fila meta_capi_events.
 *
 * POST /functions/v1/meta-capi   (header x-cron-secret: segredo do Vault)
 *   pg_cron a cada 5 min: envia os eventos vencidos (retentativas e o que sobrou).
 *
 * POST /functions/v1/meta-capi   (Authorization: Bearer <access token do usuário>, owner/admin)
 *   { "action": "test",  "workspace_id": "..." }              → envia um evento de teste (exige código de teste)
 *   { "action": "flush", "workspace_id": "..." }              → 202, envia o que está na fila do workspace
 *   { "action": "flush", "workspace_id": "...", "event_id" }  → 200, envia só esse evento e devolve o resultado
 */
import { z } from "zod";
import { errorMessage, log } from "../_shared/log.ts";
import { deliverDueEvents, sendTestEvent } from "../_shared/meta/capi-delivery.ts";
import { createAdminClient } from "../_shared/supabase-admin.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

/** Margem para o limite de 150 s das Edge Functions. */
const BUDGET_MS = 120_000;

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

const bodySchema = z.object({
  action: z.enum(["test", "flush"]),
  workspace_id: z.string().uuid(),
  event_id: z.number().int().positive().optional(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const admin = createAdminClient();

  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    const { data: ok } = await admin.rpc("service_check_cron_secret", { p_secret: cronSecret });
    if (!ok) return json(401, { error: "unauthorized" });
    try {
      const summary = await deliverDueEvents(admin, {
        limit: 200,
        deadline: Date.now() + BUDGET_MS,
      });
      return json(200, summary);
    } catch (cause) {
      log("error", "meta_capi_cron_failed", { error: errorMessage(cause) });
      return json(500, { error: "internal_error" });
    }
  }

  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: auth, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !auth.user) return json(401, { error: "unauthorized" });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "invalid_body" });
  const { action, workspace_id: workspaceId, event_id: eventId } = parsed.data;

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return json(403, { error: "forbidden" });

  try {
    if (action === "test") {
      const outcome = await sendTestEvent(admin, workspaceId);
      return json(outcome.ok ? 200 : 400, outcome);
    }
    if (eventId) {
      const summary = await deliverDueEvents(admin, { workspaceId, eventId, limit: 1 });
      return json(200, summary);
    }
    runInBackground(
      deliverDueEvents(admin, { workspaceId, limit: 200, deadline: Date.now() + BUDGET_MS }),
    );
    return json(202, { started: true });
  } catch (cause) {
    log("error", "meta_capi_manual_failed", { workspaceId, action, error: errorMessage(cause) });
    return json(500, { error: "internal_error" });
  }
});
