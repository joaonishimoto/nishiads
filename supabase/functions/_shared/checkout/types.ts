export type CheckoutProvider = "kiwify" | "hotmart" | "stripe" | "eduzz" | "generic";
/** trialing: assinatura em período de teste (ainda sem cobrança). */
export type SaleStatus = "approved" | "pending" | "refunded" | "chargeback" | "canceled" | "trialing";

/** Formato interno de `sales`, comum a todos os provedores. */
export interface NormalizedSale {
  external_order_id: string;
  status: SaleStatus;
  gross_amount_cents: number;
  net_amount_cents: number | null;
  currency: string;
  external_product_id: string | null;
  product_name: string | null;
  customer_email_hash: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  /**
   * Assinatura da venda (sub_... na Stripe). O teste usa esse id como external_order_id;
   * a primeira venda aprovada com o mesmo subscription_ref converte o teste.
   */
  subscription_ref?: string | null;
  /** Dados de clique da Meta (cookie _fbc/_fbp e user agent), para a Conversions API. */
  fbc?: string | null;
  fbp?: string | null;
  client_user_agent?: string | null;
}

export interface VerifyInput {
  rawBody: string;
  url: URL;
  headers: Headers;
  /** Segredo do Vault configurado na integração (token da Kiwify, hottok, whsec_...). */
  secret: string | null;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export type NormalizeResult =
  | { kind: "sale"; sale: NormalizedSale }
  | { kind: "ignored"; reason: string };

export interface EventSummary {
  eventType: string | null;
  externalOrderId: string | null;
}

export interface NormalizeContext {
  /** Segredo da integração (o mesmo do verify); a Stripe guarda nele também a chave de API. */
  secret: string | null;
}

/**
 * Adapter de um provedor de checkout. Para adicionar um provedor: implemente esta
 * interface em `checkout/<provedor>.ts` e registre em `checkout/registry.ts`.
 */
export interface CheckoutAdapter {
  provider: CheckoutProvider;
  /** Assinatura/token obrigatório: integração sem segredo rejeita tudo. */
  requiresSecret: boolean;
  verify(input: VerifyInput): Promise<VerifyResult>;
  /** Remove dados pessoais antes de gravar (LGPD). O resultado ainda deve ser normalizável. */
  redact(payload: unknown): Promise<unknown>;
  summarize(payload: unknown): EventSummary;
  normalize(payload: unknown, context?: NormalizeContext): Promise<NormalizeResult>;
}
