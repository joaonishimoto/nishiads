import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Cliente com a service_role (ignora RLS). Só existe dentro das Edge Functions. */
export function createAdminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórias.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
