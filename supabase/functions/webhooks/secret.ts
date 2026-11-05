import type { SupabaseClient } from "@supabase/supabase-js";

/** Segredo da integração do evento (alguns adapters usam a chave de API guardada nele). */
export async function integrationSecret(admin: SupabaseClient, integrationId: string | null): Promise<string | null> {
  if (!integrationId) return null;
  const { data: integration, error } = await admin
    .from("checkout_integrations")
    .select("webhook_secret_ref")
    .eq("id", integrationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!integration?.webhook_secret_ref) return null;
  const { data, error: secretError } = await admin.rpc("service_read_secret", {
    p_secret_id: integration.webhook_secret_ref,
  });
  if (secretError) throw new Error(secretError.message);
  return (data as string | null) ?? null;
}
