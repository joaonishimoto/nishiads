/**
 * Alertas e regras automáticas: avalia as regras do workspace (depois de cada
 * sincronização da Meta), pausa o que a regra manda pausar sozinha, avisa por push
 * e executa a pausa aprovada com um toque.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage, log } from "../log.ts";
import { setMetaObjectStatus, type WriteOptions } from "../meta/write.ts";
import { deliverPush } from "../notify/sale-notifications.ts";
import { vapidFromEnv } from "../notify/vapid.ts";
import { alertPushPayload, alertsSummaryPayload, MAX_INDIVIDUAL_PUSHES, type AlertRow } from "./messages.ts";

export type EvaluationResult = { created: number; paused: number; pending: number; delivered: number };

type PausePatch = { status: "paused" | "pending"; error: string | null; resolved_at: string | null; resolved_by: string | null };

/**
 * Pausa na Meta o objeto de um alerta já reservado (status "pausing"). Se a Meta
 * recusar, o alerta volta a pedir aprovação com o motivo, para tentar de novo.
 */
export async function executePause(
  admin: SupabaseClient,
  alert: AlertRow,
  actorUserId: string | null,
  options: WriteOptions = {},
): Promise<PausePatch> {
  let error: string | null = null;
  try {
    const result = await setMetaObjectStatus(
      admin,
      {
        workspaceId: alert.workspace_id,
        level: alert.level,
        objectId: alert.object_id,
        status: "PAUSED",
        actorUserId,
        source: "rule",
        context: { rule_id: alert.rule_id, alert_id: alert.id, reason: alert.condition, approved: actorUserId !== null },
      },
      options,
    );
    if (!result.ok) error = result.error;
  } catch (cause) {
    error = `Falha ao falar com a Meta: ${errorMessage(cause)}`.slice(0, 500);
  }
  const patch: PausePatch = error
    ? { status: "pending", error, resolved_at: null, resolved_by: null }
    : { status: "paused", error: null, resolved_at: new Date().toISOString(), resolved_by: actorUserId };
  const { error: updateError } = await admin.from("alerts").update(patch).eq("id", alert.id).eq("status", "pausing");
  if (updateError) log("error", "alert_pause_update_failed", { alertId: alert.id, error: updateError.message });
  log(error ? "warn" : "info", error ? "alert_pause_failed" : "alert_paused", {
    alertId: alert.id,
    workspaceId: alert.workspace_id,
    level: alert.level,
    objectId: alert.object_id,
    auto: actorUserId === null,
    ...(error ? { error } : {}),
  });
  return patch;
}

/** Push dos alertas novos: um por alerta, ou um resumo quando são muitos. */
async function notifyAlerts(admin: SupabaseClient, workspaceId: string, alerts: AlertRow[]): Promise<number> {
  const vapid = vapidFromEnv();
  if (!vapid || !alerts.length) return 0;
  const { data, error } = await admin.rpc("service_notification_recipients", {
    p_workspace_id: workspaceId,
    p_kind: "alert",
    p_amount_cents: 0,
  });
  if (error) throw new Error(error.message);
  const recipients = (data ?? []) as Parameters<typeof deliverPush>[1];
  if (!recipients.length) return 0;

  let delivered = 0;
  if (alerts.length <= MAX_INDIVIDUAL_PUSHES) {
    for (const alert of alerts) {
      const n = await deliverPush(admin, recipients, alertPushPayload(alert), vapid);
      delivered += n;
      await admin.from("alerts").update({ push_recipients: recipients.length, push_delivered: n }).eq("id", alert.id);
    }
  } else {
    delivered = await deliverPush(admin, recipients, alertsSummaryPayload(workspaceId, alerts), vapid);
    await admin
      .from("alerts")
      .update({ push_recipients: recipients.length, push_delivered: delivered })
      .in("id", alerts.map((a) => a.id));
  }
  return delivered;
}

/**
 * Avalia as regras ligadas do workspace. O banco garante um alerta por regra,
 * objeto e dia, e reserva as pausas automáticas dentro do limite diário de cada
 * regra; aqui elas são feitas uma a uma (a Meta limita chamadas por conta).
 */
export async function evaluateWorkspaceAlerts(
  admin: SupabaseClient,
  workspaceId: string,
  options: WriteOptions & { deadline?: number } = {},
): Promise<EvaluationResult> {
  const { data, error } = await admin.rpc("service_evaluate_alert_rules", { p_workspace_id: workspaceId });
  if (error) throw new Error(`service_evaluate_alert_rules: ${error.message}`);
  const alerts = (data ?? []) as AlertRow[];
  if (!alerts.length) return { created: 0, paused: 0, pending: 0, delivered: 0 };

  for (const alert of alerts) {
    if (alert.status !== "pausing") continue;
    if (options.deadline && Date.now() > options.deadline - 5_000) {
      // Sem tempo para chamar a Meta nesta execução: vira pedido de aprovação.
      const patch = { status: "pending" as const, error: "Não deu tempo de pausar sozinho. Aprove para pausar." };
      await admin.from("alerts").update(patch).eq("id", alert.id).eq("status", "pausing");
      Object.assign(alert, patch);
      continue;
    }
    Object.assign(alert, await executePause(admin, alert, null, options));
  }

  let delivered = 0;
  try {
    delivered = await notifyAlerts(admin, workspaceId, alerts);
  } catch (cause) {
    log("error", "alert_notify_failed", { workspaceId, error: errorMessage(cause) });
  }
  const result = {
    created: alerts.length,
    paused: alerts.filter((a) => a.status === "paused").length,
    pending: alerts.filter((a) => a.status === "pending").length,
    delivered,
  };
  log("info", "alerts_evaluated", { workspaceId, ...result });
  return result;
}

/** Igual à expiração do banco (service_evaluate_alert_rules). */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export type ApproveResult =
  | { ok: true; status: "paused" }
  | { ok: false; code: "not_found" | "forbidden" | "resolved" | "pause_failed"; error: string };

/** Pausa aprovada com um toque. Só owner e admin; dois toques não pausam duas vezes. */
export async function approveAlert(
  admin: SupabaseClient,
  alertId: string,
  userId: string,
  options: WriteOptions = {},
): Promise<ApproveResult> {
  const { data: current, error } = await admin
    .from("alerts")
    .select("id, workspace_id, status, created_at")
    .eq("id", alertId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!current) return { ok: false, code: "not_found", error: "Alerta não encontrado." };

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", current.workspace_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!member) return { ok: false, code: "not_found", error: "Alerta não encontrado." };
  if (!["owner", "admin"].includes(member.role as string)) {
    return { ok: false, code: "forbidden", error: "Só owners e admins pausam anúncios." };
  }

  // Pedido velho: os números mudaram desde então; a regra dispara de novo se ainda valer.
  if (Date.now() - new Date(current.created_at as string).getTime() > APPROVAL_TTL_MS) {
    await admin.from("alerts").update({ status: "expired", resolved_at: new Date().toISOString() }).eq("id", alertId).eq("status", "pending");
    return { ok: false, code: "resolved", error: "Este alerta expirou. Confira os números atuais em Campanhas." };
  }

  // Reserva atômica: só um pedido em aberto (ou um aviso) vira "pausando".
  const { data: claimed, error: claimError } = await admin
    .from("alerts")
    .update({ status: "pausing", error: null })
    .eq("id", alertId)
    .in("status", ["pending", "notified"])
    .select("*");
  if (claimError) throw new Error(claimError.message);
  const alert = (claimed ?? [])[0] as AlertRow | undefined;
  if (!alert) {
    if (current.status === "paused") return { ok: true, status: "paused" };
    return { ok: false, code: "resolved", error: "Este alerta já foi resolvido." };
  }

  const patch = await executePause(admin, alert, userId, options);
  return patch.status === "paused"
    ? { ok: true, status: "paused" }
    : { ok: false, code: "pause_failed", error: patch.error ?? "A Meta não confirmou a pausa." };
}
