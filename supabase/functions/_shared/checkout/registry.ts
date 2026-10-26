import { kiwifyAdapter } from "./kiwify.ts";
import { stripeAdapter } from "./stripe.ts";
import type { CheckoutAdapter, CheckoutProvider } from "./types.ts";

/** Provedores com webhook implementado. Hotmart e Eduzz entram na etapa 7. */
const adapters: Partial<Record<CheckoutProvider, CheckoutAdapter>> = {
  kiwify: kiwifyAdapter,
  stripe: stripeAdapter,
};

export function getAdapter(provider: string): CheckoutAdapter | null {
  return adapters[provider as CheckoutProvider] ?? null;
}
