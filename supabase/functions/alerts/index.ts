/**
 * Alertas e regras automáticas pelo app.
 *
 * POST /functions/v1/alerts   (Authorization: Bearer <access token do usuário>)
 *   { "action": "approve", "alert_id": "..." }       → 200 { ok: true, status: "paused" }
 *     Pausa na Meta o objeto do alerta (o "um toque" do push). Só owner/admin.
 *   { "action": "evaluate", "workspace_id": "..." }  → 200 { created, paused, pending, delivered }
 *     Avalia as regras agora, com os números da última sincronização. Só owner/admin.
 *   Erros: 4xx { error: "<código>", message }
 *
 * A avaliação normal roda sozinha no fim de cada sincronização (função meta-sync).
 */
import { z } from "zod";
import { approveAlert, evaluateWorkspaceAlerts } from "../_shared/alerts/run.ts";
import { errorMessage, log } from "../_shared/log.ts";
import { createAdminClient } from "../_shared/supabase-admin.ts";

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

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), alert_id: z.string().uuid() }),
  z.object({ action: z.literal("evaluate"), workspace_id: z.string().uuid() }),
]);

const STATUS_BY_CODE = { not_found: 404, forbidden: 403, resolved: 409, pause_failed: 502 } as const;

/** Margem para o limite de 150 s das Edge Functions. */
const BUDGET_MS = 60_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const admin = createAdminClient();

  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: auth, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !auth.user) return json(401, { error: "unauthorized" });
  const userId = auth.user.id;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "invalid_body" });
  const body = parsed.data;

  try {
    if (body.action === "approve") {
      const result = await approveAlert(admin, body.alert_id, userId);
      if (result.ok) return json(200, { ok: true, status: result.status });
      return json(STATUS_BY_CODE[result.code], { error: result.code, message: result.error });
    }

    const { data: member } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", body.workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!member || !["owner", "admin"].includes(member.role as string)) {
      return json(403, { error: "forbidden", message: "Só owners e admins avaliam as regras." });
    }
    const result = await evaluateWorkspaceAlerts(admin, body.workspace_id, { deadline: Date.now() + BUDGET_MS });
    return json(200, result);
  } catch (cause) {
    log("error", "alerts_function_failed", { action: body.action, userId, error: errorMessage(cause) });
    return json(500, { error: "internal_error" });
  }
});
