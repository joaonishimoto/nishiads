import type { SupabaseClient } from "@supabase/supabase-js";
import { stripeSessionCompleted } from "../_shared/checkout/stripe.ts";
import { errorMessage, log } from "../_shared/log.ts";
import {
  checkoutFailurePushPayload,
  type CheckoutFailureForMessage,
} from "../_shared/notify/checkout-failure-messages.ts";
import { deliverPush } from "../_shared/notify/sale-notifications.ts";
import { vapidFromEnv } from "../_shared/notify/vapid.ts";
import { integrationSecret } from "./secret.ts";

type DueDecline = {
  id: string;
  provider: string;
  session_ref: string | null;
  checkout_integration_id: string | null;
};

/**
 * Antes de avisar um cartão recusado, confere na Stripe se a Checkout Session foi
 * concluída depois (a pessoa acertou o cartão). Melhor esforço: sem resposta, segue para o
 * aviso, que ainda confere as vendas da mesma pessoa no banco.
 */
async function dropRecoveredDeclines(admin: SupabaseClient): Promise<void> {
  const { data, error } = await admin
    .from("checkout_failures")
    .select("id, provider, session_ref, checkout_integration_id")
    .is("resolution", null)
    .eq("kind", "declined")
    .eq("provider", "stripe")
    .not("session_ref", "is", null)
    .lte("notify_after", new Date().toISOString())
    .limit(50);
  if (error) throw new Error(error.message);
  const secrets = new Map<string | null, string | null>();
  for (const row of (data ?? []) as DueDecline[]) {
    try {
      if (!secrets.has(row.checkout_integration_id)) {
        secrets.set(row.checkout_integration_id, await integrationSecret(admin, row.checkout_integration_id));
      }
      const completed = await stripeSessionCompleted(secrets.get(row.checkout_integration_id) ?? null, row.session_ref!);
      if (completed) {
        await admin.rpc("service_resolve_checkout_failure", { p_failure_id: row.id, p_resolution: "recovered" });
      }
    } catch (cause) {
      log("warn", "checkout_failure_recheck_failed", { failureId: row.id, error: errorMessage(cause) });
    }
  }
}

/** Avisa as falhas de checkout vencidas (uma vez cada). Devolve quantas viraram push. */
export async function notifyDueCheckoutFailures(admin: SupabaseClient): Promise<number> {
  await dropRecoveredDeclines(admin);

  const { data, error } = await admin.rpc("service_claim_checkout_failures", { p_limit: 50 });
  if (error) throw new Error(error.message);
  const due = (data ?? []) as CheckoutFailureForMessage[];
  if (!due.length) return 0;

  const vapid = vapidFromEnv();
  for (const failure of due) {
    try {
      const { data: recipients, error: recipientsError } = await admin.rpc("service_notification_recipients", {
        p_workspace_id: failure.workspace_id,
        p_kind: "checkout_failure",
        p_amount_cents: failure.amount_cents,
      });
      if (recipientsError) throw new Error(recipientsError.message);
      const list = recipients ?? [];
      const delivered = vapid && list.length ? await deliverPush(admin, list, checkoutFailurePushPayload(failure), vapid) : 0;
      await admin
        .from("checkout_failures")
        .update({ recipients: list.length, delivered })
        .eq("id", failure.id);
      log("info", "checkout_failure_notified", {
        failureId: failure.id,
        kind: failure.kind,
        recipients: list.length,
        delivered,
      });
    } catch (cause) {
      log("error", "checkout_failure_notify_failed", { failureId: failure.id, error: errorMessage(cause) });
    }
  }
  return due.length;
}
