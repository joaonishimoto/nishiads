import type { CheckoutProvider } from "@/types/database";

type ProviderInfo = {
  label: string;
  available: boolean;
  secretLabel: string;
  secretHint: string;
  steps: string[];
};

/** Provedores de checkout. Ligar um novo: adapter na Edge Function + `available: true` aqui. */
export const PROVIDERS: Record<Exclude<CheckoutProvider, "generic">, ProviderInfo> = {
  kiwify: {
    label: "Kiwify",
    available: true,
    secretLabel: "Token do webhook",
    secretHint: "Aparece na tela do webhook na Kiwify, ao lado da URL.",
    steps: [
      "Na Kiwify, abra Apps › Webhooks e clique em Criar webhook.",
      "Dê um nome (ex.: Nishiads) e cole a URL abaixo.",
      "Escolha o produto (ou todos) e marque os eventos: Compra aprovada, Compra reembolsada, Chargeback, Pix gerado, Boleto gerado e Compra recusada.",
      "Copie o token que a Kiwify mostra e salve no campo Token aqui no Nishiads.",
      "Na Kiwify, use Testar webhook. O evento aparece em Logs de integração.",
    ],
  },
  hotmart: {
    label: "Hotmart",
    available: false,
    secretLabel: "Hottok",
    secretHint: "Em Ferramentas › Webhook (API e notificações) na Hotmart.",
    steps: [],
  },
  stripe: {
    label: "Stripe",
    available: false,
    secretLabel: "Signing secret (whsec_...)",
    secretHint: "Em Developers › Webhooks no painel da Stripe.",
    steps: [],
  },
  eduzz: {
    label: "Eduzz",
    available: false,
    secretLabel: "Token",
    secretHint: "",
    steps: [],
  },
};
