import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdapter } from "../_shared/checkout/registry.ts";
import { errorMessage, log } from "../_shared/log.ts";

const MAX_ATTEMPTS = 5;

type EventRow = {
  id: number;
  workspace_id: string;
  checkout_integration_id: string | null;
  provider: string;
  payload: unknown;
  attempts: number;
};

/** Normaliza um evento salvo e grava a venda. Idempotente: pode rodar de novo no mesmo evento. */
export async function processWebhookEvent(admin: SupabaseClient, eventId: number): Promise<void> {
  const { data: event, error } = await admin
    .from("webhook_events")
    .select("id, workspace_id, checkout_integration_id, provider, payload, attempts")
    .eq("id", eventId)
    .single<EventRow>();
  if (error || !event) {
    log("error", "webhook_event_not_found", { eventId, error: error?.message });
    return;
  }

  const attempts = event.attempts + 1;
  try {
    const adapter = getAdapter(event.provider);
    if (!adapter) throw new Error(`Provedor sem adapter: ${event.provider}`);

    const result = await adapter.normalize(event.payload);
    if (result.kind === "ignored") {
      await admin
        .from("webhook_events")
        .update({ status: "ignored", error: result.reason, attempts, processed_at: new Date().toISOString() })
        .eq("id", event.id);
      log("info", "webhook_event_ignored", { eventId, reason: result.reason });
      return;
    }

    const { data: outcome, error: ingestError } = await admin.rpc("service_ingest_sale", {
      p_workspace_id: event.workspace_id,
      p_checkout_integration_id: event.checkout_integration_id,
      p_provider: event.provider,
      p_sale: { ...result.sale, raw_payload: event.payload },
    });
    if (ingestError) throw new Error(ingestError.message);

    await admin
      .from("webhook_events")
      .update({
        status: "processed",
        error: null,
        attempts,
        sale_id: (outcome as { sale_id: string }).sale_id,
        processed_at: new Date().toISOString(),
      })
      .eq("id", event.id);

    log("info", "webhook_event_processed", { eventId, workspaceId: event.workspace_id, outcome });
  } catch (cause) {
    const message = errorMessage(cause);
    await admin
      .from("webhook_events")
      .update({ status: "failed", error: message.slice(0, 1000), attempts })
      .eq("id", event.id);
    log("error", "webhook_event_failed", { eventId, attempts, error: message });
  }
}

/** Reprocessa eventos recebidos ou com falha (chamado pelo pg_cron). */
export async function processPendingEvents(admin: SupabaseClient, limit = 50): Promise<number> {
  const { data, error } = await admin
    .from("webhook_events")
    .select("id")
    .in("status", ["received", "failed"])
    .lt("attempts", MAX_ATTEMPTS)
    .lt("received_at", new Date(Date.now() - 60_000).toISOString())
    .order("received_at")
    .limit(limit);
  if (error) throw new Error(error.message);
  for (const row of data ?? []) await processWebhookEvent(admin, row.id as number);
  return data?.length ?? 0;
}
