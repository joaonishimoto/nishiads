/**
 * POST /functions/v1/push   (Authorization: Bearer <access token do usuário>)
 *   { "action": "config" }                      → { publicKey }  chave VAPID pública para o navegador
 *   { "action": "test", "workspace_id": "..." } → { sent, delivered }  push de teste nos seus dispositivos
 */
import { errorMessage, log } from "../_shared/log.ts";
import { deliverPush } from "../_shared/notify/sale-notifications.ts";
import { vapidFromEnv } from "../_shared/notify/vapid.ts";
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const admin = createAdminClient();
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) return json(401, { error: "unauthorized" });
  const userId = auth.user.id;

  let body: { action?: string; workspace_id?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const vapid = vapidFromEnv();
  if (!vapid) return json(503, { error: "push_not_configured" });

  if (body.action === "config") return json(200, { publicKey: vapid.publicKey });

  if (body.action === "test") {
    const workspaceId = body.workspace_id ?? "";
    // Inscrições e preferências não têm FK entre si (as duas apontam para workspace_members),
    // então o PostgREST não faz o embed: busca as duas separadas.
    const [{ data: subs, error }, { data: prefs, error: prefsError }] = await Promise.all([
      admin
        .from("notification_subscriptions")
        .select("id, endpoint, config")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .eq("channel", "webpush")
        .eq("active", true),
      admin
        .from("notification_preferences")
        .select("sound_enabled")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .maybeSingle(),
    ]);
    if (error || prefsError) {
      log("error", "push_test_lookup_failed", { userId, error: (error ?? prefsError)?.message });
      return json(500, { error: "internal_error" });
    }
    try {
      const recipients = (subs ?? []).map((s) => ({
        subscription_id: s.id as string,
        user_id: userId,
        endpoint: s.endpoint as string,
        config: s.config as { p256dh?: string; auth?: string },
        sound_enabled: prefs?.sound_enabled ?? true,
      }));
      const delivered = await deliverPush(
        admin,
        recipients,
        {
          title: "🔔 Notificações ativas",
          body: "É assim que suas notificações vão aparecer no Nishistack - ADS.",
          url: `/w/${workspaceId}/vendas`,
          tag: "nishiads-test",
        },
        vapid,
      );
      return json(200, { sent: recipients.length, delivered });
    } catch (cause) {
      log("error", "push_test_failed", { userId, error: errorMessage(cause) });
      return json(500, { error: "internal_error" });
    }
  }

  return json(400, { error: "unknown_action" });
});
