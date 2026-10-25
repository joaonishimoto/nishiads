import { kiwifyAdapter } from "./kiwify.ts";
import type { CheckoutAdapter, CheckoutProvider } from "./types.ts";

/** Provedores com webhook implementado. Hotmart e Stripe entram na etapa 7. */
const adapters: Partial<Record<CheckoutProvider, CheckoutAdapter>> = {
  kiwify: kiwifyAdapter,
};

export function getAdapter(provider: string): CheckoutAdapter | null {
  return adapters[provider as CheckoutProvider] ?? null;
}
