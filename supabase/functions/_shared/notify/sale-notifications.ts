import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage, log } from "../log.ts";
import { salePushPayload, type PushPayload, type SaleNotificationKind } from "./messages.ts";
import { sendWebPush, type VapidKeys } from "./webpush.ts";
import { vapidFromEnv } from "./vapid.ts";

type Recipient = {
  subscription_id: string;
  user_id: string;
  endpoint: string;
  config: { p256dh?: string; auth?: string };
  sound_enabled: boolean;
};

/** Envia para cada inscrição; desativa as que o push service diz não existirem mais. */
export async function deliverPush(
  admin: SupabaseClient,
  recipients: Recipient[],
  payload: PushPayload,
  vapid: VapidKeys,
): Promise<number> {
  const results = await Promise.all(
    recipients.map(async (r) => {
      if (!r.config.p256dh || !r.config.auth) return false;
      try {
        const result = await sendWebPush(
          { endpoint: r.endpoint, p256dh: r.config.p256dh, auth: r.config.auth },
          { ...payload, silent: !r.sound_enabled },
          vapid,
        );
        if (result.gone) {
          await admin.from("notification_subscriptions").update({ active: false }).eq("id", r.subscription_id);
        } else if (result.ok) {
          await admin
            .from("notification_subscriptions")
            .update({ last_used_at: new Date().toISOString() })
            .eq("id", r.subscription_id);
        } else {
          log("warn", "push_rejected", { subscriptionId: r.subscription_id, status: result.status });
        }
        return result.ok;
      } catch (cause) {
        log("error", "push_failed", { subscriptionId: r.subscription_id, error: errorMessage(cause) });
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

/**
 * Notifica uma mudança de venda. Idempotente: notification_log aceita uma linha
 * por venda e tipo, então reenvios do mesmo webhook não repetem o push.
 */
export async function notifySale(admin: SupabaseClient, saleId: string, kind: SaleNotificationKind): Promise<void> {
  const vapid = vapidFromEnv();
  if (!vapid) {
    log("warn", "push_disabled_missing_vapid", { saleId });
    return;
  }

  const { data: sale, error: saleError } = await admin
    .from("sales")
    .select(
      "id, workspace_id, gross_amount_cents, currency, product_name, campaign:campaigns(name), ad:ads(name)",
    )
    .eq("id", saleId)
    .single();
  if (saleError || !sale) throw new Error(saleError?.message ?? "Venda não encontrada.");

  const { data: logged, error: logError } = await admin
    .from("notification_log")
    .upsert({ workspace_id: sale.workspace_id, sale_id: sale.id, kind }, { onConflict: "sale_id,kind", ignoreDuplicates: true })
    .select("id");
  if (logError) throw new Error(logError.message);
  if (!logged || logged.length === 0) return; // já notificada

  const { data: recipients, error: recipientsError } = await admin.rpc("service_notification_recipients", {
    p_workspace_id: sale.workspace_id,
    p_kind: kind,
    p_amount_cents: sale.gross_amount_cents,
  });
  if (recipientsError) throw new Error(recipientsError.message);
  const list = (recipients ?? []) as Recipient[];

  const one = <T,>(value: T | T[] | null): T | null => (Array.isArray(value) ? (value[0] ?? null) : value);
  const payload = salePushPayload(kind, {
    id: sale.id,
    workspace_id: sale.workspace_id,
    gross_amount_cents: sale.gross_amount_cents,
    currency: sale.currency,
    product_name: sale.product_name,
    campaign_name: one(sale.campaign as { name: string } | { name: string }[] | null)?.name ?? null,
    ad_name: one(sale.ad as { name: string } | { name: string }[] | null)?.name ?? null,
  });

  const delivered = list.length ? await deliverPush(admin, list, payload, vapid) : 0;
  await admin
    .from("notification_log")
    .update({ recipients: list.length, delivered })
    .eq("id", (logged[0] as { id: number }).id);
  log("info", "sale_notified", { saleId, kind, recipients: list.length, delivered });
}
