import type { CheckoutProvider } from "@/types/database";

export type SecretField = {
  key: string;
  label: string;
  hint: string;
  placeholder: string;
  /** Validação do formato (ex.: prefixo whsec_). */
  pattern: RegExp;
  patternMessage: string;
};

/** Passo do guia. `copyItems` vira uma lista de valores com botão de copiar (ex.: nomes de eventos). */
export type GuideStep = string | { text: string; copyItems: string[] };

type ProviderInfo = {
  label: string;
  available: boolean;
  secretLabel: string;
  secretHint: string;
  /** Provedores com mais de um segredo: os campos viram um JSON guardado no Vault. */
  secretFields?: SecretField[];
  steps: GuideStep[];
  /** Observação abaixo dos passos (ex.: como enviar as UTMs). */
  note?: string;
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
      "Dê um nome (ex.: Nishiads) e cole a URL do webhook que aparece no card da integração aqui no Nishiads.",
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
    available: true,
    secretLabel: "Chaves da Stripe",
    secretHint: "",
    secretFields: [
      {
        key: "webhook_secret",
        label: "Signing secret do webhook",
        hint: "Na Stripe, abra o destino do webhook e clique em Revelar ao lado de Segredo de assinatura.",
        placeholder: "whsec_...",
        pattern: /^whsec_[A-Za-z0-9]{16,}$/,
        patternMessage: "Cole o signing secret completo, que começa com whsec_.",
      },
      {
        key: "api_key",
        label: "Chave restrita (só leitura)",
        hint: "Usada para ligar a fatura da assinatura ao pagamento e buscar as UTMs da Checkout Session.",
        placeholder: "rk_live_...",
        pattern: /^rk_(live|test)_[A-Za-z0-9]{16,}$/,
        patternMessage: "Use uma chave restrita, que começa com rk_live_ (ou rk_test_ para testes).",
      },
    ],
    steps: [
      "Na Stripe, abra Desenvolvedores › Webhooks e clique em Adicionar destino. Em Eventos de, deixe Sua conta.",
      {
        text: "Selecione os 6 eventos abaixo (copie cada nome e cole na busca de eventos) e clique em Continuar:",
        copyItems: [
          "checkout.session.completed",
          "checkout.session.async_payment_succeeded",
          "checkout.session.async_payment_failed",
          "invoice.paid",
          "charge.refunded",
          "charge.dispute.created",
        ],
      },
      "Em Tipo de destino, escolha Endpoint de webhook e clique em Continuar.",
      "Dê um nome ao destino (ex.: Nishiads). Em URL do endpoint, cole a URL do webhook que aparece no card da integração aqui no Nishiads e clique em Criar destino.",
      "Na página do destino criado, clique em Revelar ao lado de Segredo de assinatura e copie o valor (whsec_...).",
      "Agora a chave de leitura: em Desenvolvedores › Chaves de API, clique em Criar chave secret e escolha Alimentando uma integração que você criou. Na tela seguinte, escolha a chave restrita.",
      "Dê o nome Nishiads. Nas permissões, marque Leitura em Checkout Sessions, Invoices e Charges e deixe o resto em Nenhum. Crie e copie a chave (rk_live_...).",
      "Clique em Salvar chaves aqui e cole as duas.",
      "Para conferir, reenvie um evento pela Stripe (no destino do webhook, abra um evento e clique em Reenviar). Ele aparece em Logs de integração.",
    ],
    note:
      "Para atribuir a venda ao anúncio, o seu checkout precisa enviar utm_source, utm_medium, utm_campaign, utm_content e utm_term no metadata da Checkout Session (e em subscription_data.metadata, para as renovações). Cada renovação da assinatura entra como uma venda nova, atribuída ao anúncio da primeira compra. Webhooks que você já tem na Stripe continuam funcionando.",
  },
  eduzz: {
    label: "Eduzz",
    available: false,
    secretLabel: "Token",
    secretHint: "",
    steps: [],
  },
};
