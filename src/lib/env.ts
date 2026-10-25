import { z } from "zod";

const envSchema = z.object({
  VITE_SUPABASE_URL: z.string().url("VITE_SUPABASE_URL precisa ser a URL do projeto Supabase."),
  VITE_SUPABASE_ANON_KEY: z.string().min(20, "VITE_SUPABASE_ANON_KEY ausente ou inválida."),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(import.meta.env);

/** Variáveis públicas do frontend. Segredos nunca entram aqui: ficam nas Edge Functions. */
export const env: Env | null = parsed.success ? parsed.data : null;

export const envErrors: string[] = parsed.success ? [] : parsed.error.issues.map((i) => i.message);
