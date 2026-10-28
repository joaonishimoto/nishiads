import type { VapidKeys } from "./webpush.ts";

/** Chaves VAPID dos secrets da Edge Function. Sem elas, o push fica desligado (sem erro). */
export function vapidFromEnv(): VapidKeys | null {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY")?.trim();
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY")?.trim();
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: Deno.env.get("VAPID_SUBJECT")?.trim() || "https://ads.nishistack.com",
  };
}
