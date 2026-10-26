/**
 * Controle da Meta Ads pelo app.
 *
 * POST /functions/v1/meta-actions   (Authorization: Bearer <access token do usuário>)
 *   { "workspace_id", "level": "campaign"|"adset"|"ad", "id": "<nosso uuid>",
 *     "action": "pause"|"activate" }
 *   { ..., "action": "set_budget", "budget_cents": 5000 }   (campanha ou conjunto)
 *   → 200 { ok: true, object: { status, effective_status, daily_budget_cents, lifetime_budget_cents } }
 *   → 4xx { error: "<kind>", message }
 *   Só owner/admin. Cada tentativa fica em meta_action_log.
 */
import { z } from "zod";
import { errorMessage, log } from "../_shared/log.ts";
import { setMetaBudget, setMetaObjectStatus, type WriteErrorKind } from "../_shared/meta/write.ts";
import { createAdminClient } from "../_shared/supabase-admin.ts";

/** Proteção contra clique repetido ou script: ações por usuário por minuto. */
const MAX_ACTIONS_PER_MINUTE = 20;

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

const base = {
  workspace_id: z.string().uuid(),
  level: z.enum(["campaign", "adset", "ad"]),
  id: z.string().uuid(),
};
const bodySchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("pause") }),
  z.object({ ...base, action: z.literal("activate") }),
  z.object({
    ...base,
    level: z.enum(["campaign", "adset"]),
    action: z.literal("set_budget"),
    budget_cents: z.number().int().positive(),
  }),
]);

const STATUS_BY_KIND: Record<WriteErrorKind, number> = {
  invalid: 422,
  not_found: 404,
  needs_reconnect: 409,
  missing_permission: 403,
  rate_limit: 429,
  meta_error: 502,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const admin = createAdminClient();

  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: auth, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !auth.user) return json(401, { error: "unauthorized" });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "invalid_body" });
  const body = parsed.data;

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", body.workspace_id)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!member || !["owner", "admin"].includes(member.role as string)) return json(403, { error: "forbidden" });

  const { count } = await admin
    .from("meta_action_log")
    .select("id", { count: "exact", head: true })
    .eq("actor_user_id", auth.user.id)
    .gte("created_at", new Date(Date.now() - 60_000).toISOString());
  if ((count ?? 0) >= MAX_ACTIONS_PER_MINUTE) {
    return json(429, { error: "too_many_actions", message: "Muitas alterações seguidas. Espere um minuto." });
  }

  const input = {
    workspaceId: body.workspace_id,
    objectId: body.id,
    actorUserId: auth.user.id,
    source: "manual" as const,
  };
  try {
    const result = body.action === "set_budget"
      ? await setMetaBudget(admin, { ...input, level: body.level, budgetCents: body.budget_cents })
      : await setMetaObjectStatus(admin, {
        ...input,
        level: body.level,
        status: body.action === "pause" ? "PAUSED" : "ACTIVE",
      });
    if (result.ok) return json(200, { ok: true, object: result.object });
    return json(STATUS_BY_KIND[result.kind], { error: result.kind, message: result.error });
  } catch (cause) {
    log("error", "meta_actions_failed", { objectId: body.id, action: body.action, error: errorMessage(cause) });
    return json(500, { error: "internal_error" });
  }
});
