import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { env } from "@/lib/env";

export type AppSupabaseClient = SupabaseClient<Database>;

// Sem env válido, o App mostra a tela de configuração e nunca chama este cliente.
export const supabase: AppSupabaseClient = createClient<Database>(
  env?.VITE_SUPABASE_URL ?? "http://localhost",
  env?.VITE_SUPABASE_ANON_KEY ?? "missing-anon-key",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  },
);
