/**
 * Resumo diário por push.
 *
 * POST /functions/v1/daily-summary   (header x-cron-secret: segredo do Vault)
 *   Chamado pelo pg_cron a cada 5 min: manda os resumos cujo horário chegou.
 *
 * POST /functions/v1/daily-summary   (Authorization: Bearer <access token do usuário>)
 *   { "action": "test", "workspace_id": "...", "period"?, "title_template"?, "body_template"? }
 *     → { sent, delivered, title, body }  manda agora, só para você, com o texto do editor.
 */
import { z } from "zod";
import {
  DEFAULT_BODY,
  DEFAULT_TITLE,
  renderSummary,
  type DailySummaryNumbers,
} from "../_shared/daily-summary/template.ts";
import { errorMessage, log } from "../_shared/log.ts";
import { deliverPush } from "../_shared/notify/sale-notifications.ts";
import { vapidFromEnv } from "../_shared/notify/vapid.ts";
import type { VapidKeys } from "../_shared/notify/webpush.ts";
import { createAdminClient } from "../_shared/supabase-admin.ts";

type Admin = ReturnType<typeof createAdminClient>;

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

const testSchema = z.object({
  action: z.literal("test"),
  workspace_id: z.string().uuid(),
  period: z.enum(["today", "yesterday"]).optional(),
  title_template: z.string().trim().min(1).max(120).optional(),
  body_template: z.string().trim().min(1).max(1000).optional(),
});

type Claimed = {
  workspace_id: string;
  user_id: string;
  period: "today" | "yesterday";
  title_template: string;
  body_template: string;
  scheduled_on: string;
  summary_day: string;
  until_at: string | null;
};

/** Dia de hoje (AAAA-MM-DD) no fuso do workspace. */
function todayIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function previousDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function numbersFor(admin: Admin, workspaceId: string, day: string, until: string | null) {
  const { data, error } = await admin.rpc("service_daily_summary_numbers", {
    p_workspace_id: workspaceId,
    p_day: day,
    p_until: until,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Workspace não encontrado.");
  return data as DailySummaryNumbers;
}

/** Envia o resumo para os dispositivos ativos da pessoa no workspace. */
async function sendTo(
  admin: Admin,
  vapid: VapidKeys,
  workspaceId: string,
  userId: string,
  message: { title: string; body: string },
  day: string,
): Promise<{ sent: number; delivered: number }> {
  const [{ data: subs, error }, { data: prefs }] = await Promise.all([
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
  if (error) throw new Error(error.message);
  const recipients = (subs ?? []).map((s) => ({
    subscription_id: s.id as string,
    user_id: userId,
    endpoint: s.endpoint as string,
    config: s.config as { p256dh?: string; auth?: string },
    sound_enabled: prefs?.sound_enabled ?? true,
  }));
  if (!recipients.length) return { sent: 0, delivered: 0 };
  const delivered = await deliverPush(
    admin,
    recipients,
    { ...message, url: `/w/${workspaceId}`, tag: `daily-summary:${workspaceId}:${day}` },
    vapid,
  );
  return { sent: recipients.length, delivered };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const admin = createAdminClient();
  const vapid = vapidFromEnv();

  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    const { data: ok } = await admin.rpc("service_check_cron_secret", { p_secret: cronSecret });
    if (!ok) return json(401, { error: "unauthorized" });
    if (!vapid) {
      log("warn", "daily_summary_skipped_missing_vapid", {});
      return json(503, { error: "push_not_configured" });
    }
    const { data, error } = await admin.rpc("service_claim_daily_summaries", {});
    if (error) {
      log("error", "daily_summary_claim_failed", { error: error.message });
      return json(500, { error: "internal_error" });
    }
    const due = (data ?? []) as Claimed[];
    let delivered = 0;
    let failed = 0;
    for (const s of due) {
      try {
        const numbers = await numbersFor(admin, s.workspace_id, s.summary_day, s.until_at);
        const message = renderSummary({ title: s.title_template, body: s.body_template }, numbers);
        const result = await sendTo(
          admin,
          vapid,
          s.workspace_id,
          s.user_id,
          message,
          s.summary_day,
        );
        delivered += result.delivered;
      } catch (cause) {
        failed++;
        log("error", "daily_summary_failed", {
          workspaceId: s.workspace_id,
          userId: s.user_id,
          error: errorMessage(cause),
        });
      }
    }
    log("info", "daily_summary_cron_done", { due: due.length, delivered, failed });
    return json(200, { due: due.length, delivered, failed });
  }

  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: auth, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !auth.user) return json(401, { error: "unauthorized" });
  const userId = auth.user.id;

  const parsed = testSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "invalid_body" });
  const body = parsed.data;
  if (!vapid) return json(503, { error: "push_not_configured" });

  const [{ data: member }, { data: workspace }, { data: saved }] = await Promise.all([
    admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", body.workspace_id)
      .eq("user_id", userId)
      .maybeSingle(),
    admin.from("workspaces").select("timezone").eq("id", body.workspace_id).maybeSingle(),
    admin
      .from("daily_summary_settings")
      .select("period, title_template, body_template")
      .eq("workspace_id", body.workspace_id)
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  if (!member || !workspace) return json(403, { error: "forbidden" });

  try {
    const period = body.period ?? (saved?.period as "today" | "yesterday" | undefined) ?? "today";
    const today = todayIn(workspace.timezone as string);
    const day = period === "yesterday" ? previousDay(today) : today;
    const numbers = await numbersFor(
      admin,
      body.workspace_id,
      day,
      period === "yesterday" ? null : new Date().toISOString(),
    );
    const message = renderSummary(
      {
        title:
          body.title_template ?? (saved?.title_template as string | undefined) ?? DEFAULT_TITLE,
        body: body.body_template ?? (saved?.body_template as string | undefined) ?? DEFAULT_BODY,
      },
      numbers,
    );
    const result = await sendTo(admin, vapid, body.workspace_id, userId, message, day);
    return json(200, { ...result, ...message });
  } catch (cause) {
    log("error", "daily_summary_test_failed", { userId, error: errorMessage(cause) });
    return json(500, { error: "internal_error" });
  }
});
