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
  /**
   * Quem comprou, no app do cliente (metadata.user_id na Stripe). Uma venda sem UTM herda
   * o anúncio do cadastro dessa pessoa no rastreamento do app.
   */
  person_ref?: string | null;
}

export interface VerifyInput {
  rawBody: string;
  url: URL;
  headers: Headers;
  /** Segredo do Vault configurado na integração (token da Kiwify, hottok, whsec_...). */
  secret: string | null;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Tentativa de checkout que não deu certo:
 * declined (cartão recusado), expired (checkout abandonado) ou
 * renewal_failed (cobrança recusada no fim do teste ou na renovação).
 */
export type CheckoutFailureKind = "declined" | "expired" | "renewal_failed";

export interface NormalizedCheckoutFailure {
  kind: CheckoutFailureKind;
  /** Id da tentativa no provedor (seti_/pi_/cs_/in_...). */
  external_ref: string;
  /** Checkout Session da tentativa, para conferir depois se foi concluída. */
  session_ref: string | null;
  subscription_ref: string | null;
  amount_cents: number;
  currency: string;
  external_product_id: string | null;
  product_name: string | null;
  customer_email_hash: string | null;
  person_ref: string | null;
  /** decline_code/código do erro, ex.: insufficient_funds. */
  reason_code: string | null;
  reason_message: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  /** Quando a pessoa começou a tentar (abertura do checkout ou a recusa). */
  started_at: string | null;
  occurred_at: string | null;
  /** Minutos de espera antes do aviso (a pessoa pode acertar o cartão logo depois). */
  delay_minutes: number;
}

export type NormalizeResult =
  | { kind: "sale"; sale: NormalizedSale }
  | { kind: "failure"; failure: NormalizedCheckoutFailure }
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
