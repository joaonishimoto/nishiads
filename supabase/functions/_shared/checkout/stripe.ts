/**
 * Stripe: webhook assinado (Stripe-Signature, HMAC-SHA256) + chave restrita só de leitura.
 *
 * A venda é identificada pelo PaymentIntent (pi_...), que aparece no pagamento avulso, no
 * reembolso e no chargeback. Desde a API 2025-03-31.basil a fatura de assinatura não traz
 * mais o PaymentIntent no webhook, então a chave de API resolve fatura → pagamento e busca
 * as UTMs da Checkout Session que criou a assinatura.
 *
 * Teste grátis: o checkout de assinatura sem cobrança (ou a primeira fatura de valor zero)
 * vira um registro "trialing" identificado pela assinatura (sub_...). A primeira fatura paga
 * da assinatura converte o teste.
 *
 * Checkout com falha (vira um aviso, não uma venda):
 *   setup_intent.setup_failed / payment_intent.payment_failed → cartão recusado no checkout
 *   checkout.session.expired → checkout aberto e não concluído
 *   invoice.payment_failed → cobrança recusada no fim do teste ou na renovação
 */
import { hashEmail, hmacHex, timingSafeEqual } from "../crypto.ts";
import { cleanText } from "../values.ts";
import { clickIdsFrom } from "./click-ids.ts";
import type {
  CheckoutAdapter,
  NormalizeResult,
  NormalizedCheckoutFailure,
  NormalizedSale,
  SaleStatus,
} from "./types.ts";

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const STRIPE_API = "https://api.stripe.com/v1";
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
/** Cartão recusado espera esse tempo antes do aviso: muita gente acerta o cartão logo depois. */
export const DECLINE_DELAY_MINUTES = 20;

type Obj = Record<string, unknown>;

export interface StripeSecret {
  webhookSecret: string;
  apiKey: string | null;
}

/** O segredo da integração Stripe é um JSON com as duas chaves (ou só o whsec_, legado). */
export function parseStripeSecret(secret: string | null): StripeSecret | null {
  if (!secret) return null;
  const text = secret.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { webhook_secret?: unknown; api_key?: unknown };
      if (typeof parsed.webhook_secret !== "string" || !parsed.webhook_secret) return null;
      return {
        webhookSecret: parsed.webhook_secret,
        apiKey: typeof parsed.api_key === "string" && parsed.api_key ? parsed.api_key : null,
      };
    } catch {
      return null;
    }
  }
  return { webhookSecret: text, apiKey: null };
}

function obj(value: unknown): Obj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Campo que pode vir como id ("pi_...") ou como objeto expandido ({ id }). */
function idOf(value: unknown): string | null {
  return str(value) ?? str(obj(value)?.id);
}

function unixToMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : Date.now();
}

function unixToIso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function utmsFrom(metadata: unknown): Partial<Record<(typeof UTM_KEYS)[number], string | null>> {
  const m = obj(metadata);
  if (!m) return {};
  const out: Partial<Record<(typeof UTM_KEYS)[number], string | null>> = {};
  for (const key of UTM_KEYS) {
    const value = cleanText(m[key]);
    if (value) out[key] = value;
  }
  return out;
}

/** E-mail em claro (payload original) ou o hash que o redact deixou no lugar. */
async function emailHash(object: Obj, email: string | null): Promise<string | null> {
  const stored = str(object.customer_email_sha256);
  return (await hashEmail(email)) ?? (stored && /^[0-9a-f]{64}$/.test(stored) ? stored : null);
}

const hasUtm = (u: Partial<Record<string, string | null>>) => Object.values(u).some(Boolean);

/** Quem comprou, no app do cliente: metadata.user_id (o checkout da Drinfy manda assim). */
function personRef(metadata: unknown): string | null {
  return cleanText(obj(metadata)?.user_id, 200);
}

async function stripeGet(apiKey: string, path: string, params: Record<string, string>): Promise<Obj> {
  const url = new URL(`${STRIPE_API}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.append(key, value);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const body = (await response.json().catch(() => ({}))) as Obj;
  if (!response.ok) {
    const message = str(obj(body.error)?.message) ?? `HTTP ${response.status}`;
    throw new Error(`Stripe API ${path}: ${message}`);
  }
  return body;
}

function firstOfList(list: Obj): Obj | null {
  const data = list.data;
  return Array.isArray(data) ? obj(data[0]) : null;
}

function baseSale(partial: Partial<NormalizedSale> & Pick<NormalizedSale, "external_order_id" | "status">): NormalizedSale {
  return {
    gross_amount_cents: 0,
    net_amount_cents: null,
    currency: "BRL",
    external_product_id: null,
    product_name: null,
    customer_email_hash: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    paid_at: null,
    refunded_at: null,
    ...partial,
  };
}

function currencyOf(value: unknown): string {
  return (str(value) ?? "brl").toUpperCase().slice(0, 3);
}

const ignored = (reason: string): NormalizeResult => ({ kind: "ignored", reason });

async function fromCheckoutSession(type: string, session: Obj, apiKey: string | null): Promise<NormalizeResult> {
  const mode = str(session.mode);
  if (mode === "subscription") return fromSubscriptionCheckout(type, session, apiKey);
  if (mode !== "payment") return ignored(`Checkout Session em modo ${mode ?? "desconhecido"}.`);

  const paymentIntent = idOf(session.payment_intent);
  if (!paymentIntent) return ignored("Checkout Session sem PaymentIntent.");

  let status: SaleStatus;
  if (type === "checkout.session.async_payment_failed") status = "canceled";
  else if (type === "checkout.session.async_payment_succeeded" || session.payment_status === "paid") status = "approved";
  else status = "pending";

  const product = await sessionProduct(session, apiKey);
  const details = obj(session.customer_details);
  return {
    kind: "sale",
    sale: baseSale({
      external_order_id: paymentIntent,
      status,
      gross_amount_cents: cents(session.amount_total) ?? 0,
      currency: currencyOf(session.currency),
      external_product_id: product.id,
      product_name: product.name,
      customer_email_hash: await emailHash(session, str(details?.email) ?? str(session.customer_email)),
      ...utmsFrom(session.metadata),
      ...clickIdsFrom(session.metadata, unixToMs(session.created)),
      person_ref: personRef(session.metadata),
      paid_at: status === "approved" ? (unixToIso(session.created) ?? new Date().toISOString()) : null,
    }),
  };
}

/** Produto da Checkout Session: metadata (product_name/product_id) ou o 1º item. */
async function sessionProduct(session: Obj, apiKey: string | null) {
  const metadata = obj(session.metadata);
  let name = cleanText(metadata?.product_name, 200);
  let id = cleanText(metadata?.product_id, 200);
  if ((!name || !id) && apiKey && str(session.id)) {
    const line = firstOfList(await stripeGet(apiKey, `/checkout/sessions/${session.id}/line_items`, { limit: "1" }));
    name ??= cleanText(line?.description, 200);
    id ??= idOf(obj(line?.price)?.product);
  }
  return { name, id };
}

/** Checkout de assinatura: com cobrança, a venda entra pelo invoice.paid; sem cobrança, é um teste. */
async function fromSubscriptionCheckout(type: string, session: Obj, apiKey: string | null): Promise<NormalizeResult> {
  const free = session.payment_status === "no_payment_required" || cents(session.amount_total) === 0;
  if (!free) return ignored("Assinatura: a venda entra pelo evento invoice.paid.");
  if (type !== "checkout.session.completed") return ignored(`Evento ${type} de assinatura sem cobrança.`);
  const subscriptionId = idOf(session.subscription);
  if (!subscriptionId) return ignored("Checkout de assinatura sem id de assinatura.");

  const product = await sessionProduct(session, apiKey);
  const details = obj(session.customer_details);
  return {
    kind: "sale",
    sale: baseSale({
      external_order_id: subscriptionId,
      subscription_ref: subscriptionId,
      status: "trialing",
      currency: currencyOf(session.currency),
      external_product_id: product.id,
      product_name: product.name,
      customer_email_hash: await emailHash(session, str(details?.email) ?? str(session.customer_email)),
      ...utmsFrom(session.metadata),
      ...clickIdsFrom(session.metadata, unixToMs(session.created)),
      person_ref: personRef(session.metadata),
    }),
  };
}

/**
 * Rastreamento da assinatura (UTMs e dados de clique): metadata da assinatura ou, sem
 * UTMs nela, da Checkout Session que a criou.
 */
async function subscriptionTracking(metadata: unknown, subscriptionId: string | null, apiKey: string | null) {
  let source = metadata;
  let utms = utmsFrom(source);
  let observedAt = Date.now();
  if (!hasUtm(utms) && apiKey && subscriptionId) {
    const session = firstOfList(
      await stripeGet(apiKey, "/checkout/sessions", { subscription: subscriptionId, limit: "1" }),
    );
    source = session?.metadata;
    utms = utmsFrom(source);
    observedAt = unixToMs(session?.created);
  }
  return {
    ...utms,
    ...clickIdsFrom(source, observedAt),
    person_ref: personRef(source) ?? personRef(metadata),
  };
}

function invoiceProduct(invoice: Obj) {
  const lines = obj(invoice.lines);
  const line = Array.isArray(lines?.data) ? obj(lines.data[0]) : null;
  const priceDetails = obj(obj(line?.pricing)?.price_details);
  return {
    id: idOf(priceDetails?.product) ?? idOf(obj(line?.price)?.product),
    name: cleanText(line?.description, 200),
  };
}

async function fromInvoice(invoice: Obj, apiKey: string | null): Promise<NormalizeResult> {
  const parent = obj(invoice.parent);
  const subscriptionDetails = obj(parent?.subscription_details) ?? obj(invoice.subscription_details);
  const subscriptionId = idOf(subscriptionDetails?.subscription) ?? idOf(invoice.subscription);

  const amountPaid = cents(invoice.amount_paid) ?? 0;
  if (amountPaid === 0) {
    // Primeira fatura zerada da assinatura = início do teste (cobre assinaturas criadas fora do Checkout).
    if (!subscriptionId || invoice.billing_reason !== "subscription_create") {
      return ignored("Fatura de valor zero que não inicia um teste.");
    }
    const product = invoiceProduct(invoice);
    return {
      kind: "sale",
      sale: baseSale({
        external_order_id: subscriptionId,
        subscription_ref: subscriptionId,
        status: "trialing",
        currency: currencyOf(invoice.currency),
        external_product_id: product.id,
        product_name: product.name,
        customer_email_hash: await emailHash(invoice, str(invoice.customer_email)),
        ...(await subscriptionTracking(subscriptionDetails?.metadata, subscriptionId, apiKey)),
      }),
    };
  }
  const invoiceId = str(invoice.id);
  if (!invoiceId) throw new Error("Fatura da Stripe sem id.");

  // API < basil: invoice.payment_intent. Basil+: Invoice Payments.
  let paymentIntent = idOf(invoice.payment_intent);
  if (!paymentIntent && apiKey) {
    const payment = firstOfList(
      await stripeGet(apiKey, "/invoice_payments", { invoice: invoiceId, status: "paid", limit: "1" }),
    );
    paymentIntent = idOf(obj(payment?.payment)?.payment_intent);
  }

  const tracking = await subscriptionTracking(subscriptionDetails?.metadata, subscriptionId, apiKey);
  const product = invoiceProduct(invoice);

  return {
    kind: "sale",
    sale: baseSale({
      external_order_id: paymentIntent ?? invoiceId,
      subscription_ref: subscriptionId,
      status: "approved",
      gross_amount_cents: amountPaid,
      currency: currencyOf(invoice.currency),
      external_product_id: product.id,
      product_name: product.name,
      customer_email_hash: await emailHash(invoice, str(invoice.customer_email)),
      ...tracking,
      paid_at: unixToIso(obj(invoice.status_transitions)?.paid_at) ?? unixToIso(invoice.created),
    }),
  };
}

async function fromRefundedCharge(charge: Obj): Promise<NormalizeResult> {
  if (charge.refunded !== true) return ignored("Reembolso parcial: a venda continua aprovada.");
  const id = idOf(charge.payment_intent) ?? str(charge.id);
  if (!id) throw new Error("Charge da Stripe sem id.");
  const refunds = obj(charge.refunds);
  const lastRefund = Array.isArray(refunds?.data) ? obj(refunds.data[0]) : null;
  return {
    kind: "sale",
    sale: baseSale({
      external_order_id: id,
      status: "refunded",
      gross_amount_cents: cents(charge.amount) ?? 0,
      currency: currencyOf(charge.currency),
      customer_email_hash: await emailHash(charge, str(obj(charge.billing_details)?.email)),
      paid_at: unixToIso(charge.created),
      refunded_at: unixToIso(lastRefund?.created) ?? new Date().toISOString(),
    }),
  };
}

async function fromDispute(dispute: Obj, apiKey: string | null): Promise<NormalizeResult> {
  let id = idOf(dispute.payment_intent);
  const chargeId = idOf(dispute.charge);
  if (!id && apiKey && chargeId) id = idOf((await stripeGet(apiKey, `/charges/${chargeId}`, {})).payment_intent);
  id ??= chargeId;
  if (!id) throw new Error("Disputa da Stripe sem PaymentIntent nem Charge.");
  return {
    kind: "sale",
    sale: baseSale({
      external_order_id: id,
      status: "chargeback",
      gross_amount_cents: cents(dispute.amount) ?? 0,
      currency: currencyOf(dispute.currency),
      refunded_at: unixToIso(dispute.created) ?? new Date().toISOString(),
    }),
  };
}


// ---------------------------------------------------------------------------
// Checkout com falha
// ---------------------------------------------------------------------------

function failure(
  partial: Partial<NormalizedCheckoutFailure> & Pick<NormalizedCheckoutFailure, "kind" | "external_ref">,
): NormalizeResult {
  return {
    kind: "failure",
    failure: {
      session_ref: null,
      subscription_ref: null,
      amount_cents: 0,
      currency: "BRL",
      external_product_id: null,
      product_name: null,
      customer_email_hash: null,
      person_ref: null,
      reason_code: null,
      reason_message: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      utm_content: null,
      utm_term: null,
      started_at: null,
      occurred_at: null,
      delay_minutes: 0,
      ...partial,
    },
  };
}

/** Nome do produto quando a API não responde: o plano do metadata (ex.: annual). */
async function sessionProductSafe(session: Obj, apiKey: string | null) {
  try {
    return await sessionProduct(session, apiKey);
  } catch {
    return { name: cleanText(obj(session.metadata)?.plan, 200), id: null };
  }
}

/** O que a Checkout Session diz sobre quem tentou: e-mail, pessoa, UTMs, produto e valor. */
async function sessionContext(session: Obj, apiKey: string | null) {
  const product = await sessionProductSafe(session, apiKey);
  const details = obj(session.customer_details);
  return {
    session_ref: str(session.id),
    amount_cents: cents(session.amount_total) ?? 0,
    currency: currencyOf(session.currency),
    external_product_id: product.id,
    product_name: product.name ?? cleanText(obj(session.metadata)?.plan, 200),
    customer_email_hash: await emailHash(session, str(details?.email) ?? str(session.customer_email)),
    person_ref: personRef(session.metadata),
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    ...utmsFrom(session.metadata),
  };
}

async function fromExpiredSession(session: Obj, apiKey: string | null): Promise<NormalizeResult> {
  const id = str(session.id);
  if (!id) throw new Error("Checkout Session da Stripe sem id.");
  const mode = str(session.mode);
  if (mode !== "payment" && mode !== "subscription") return ignored(`Checkout Session em modo ${mode ?? "desconhecido"}.`);
  return failure({
    kind: "expired",
    external_ref: id,
    ...(await sessionContext(session, apiKey)),
    started_at: unixToIso(session.created),
    occurred_at: unixToIso(session.expires_at) ?? new Date().toISOString(),
  });
}

/**
 * A recusa no checkout de assinatura com teste (SetupIntent) não traz metadata nem
 * cliente. A Checkout Session aberta com o mesmo e-mail diz quem é e de qual anúncio veio.
 */
async function openSessionByEmail(apiKey: string, emailHash: string, at: number): Promise<Obj | null> {
  const list = await stripeGet(apiKey, "/checkout/sessions", {
    status: "open",
    "created[gte]": String(Math.floor(at / 1000) - 24 * 3600),
    limit: "100",
  });
  const sessions = Array.isArray(list.data) ? list.data.map(obj).filter((s): s is Obj => s !== null) : [];
  let best: Obj | null = null;
  for (const session of sessions) {
    const email = str(obj(session.customer_details)?.email) ?? str(session.customer_email);
    if ((await hashEmail(email)) !== emailHash) continue;
    if (!best || Number(session.created) > Number(best.created)) best = session;
  }
  return best;
}

function errorReason(error: Obj | null) {
  return {
    reason_code: cleanText(error?.decline_code, 100) ?? cleanText(error?.code, 100),
    reason_message: cleanText(error?.message, 500),
  };
}

async function fromSetupFailed(seti: Obj, apiKey: string | null, eventAt: number): Promise<NormalizeResult> {
  const id = str(seti.id);
  if (!id) throw new Error("SetupIntent da Stripe sem id.");
  const error = obj(seti.last_setup_error);
  const email = str(obj(obj(error?.payment_method)?.billing_details)?.email);
  const hash = await emailHash(seti, email);
  let context: Partial<NormalizedCheckoutFailure> = {
    customer_email_hash: hash,
    person_ref: personRef(seti.metadata),
    ...utmsFrom(seti.metadata),
  };
  if (apiKey && hash) {
    try {
      const session = await openSessionByEmail(apiKey, hash, eventAt);
      if (session) context = { ...(await sessionContext(session, apiKey)), customer_email_hash: hash };
    } catch {
      // Sem a sessão, o aviso sai sem produto e sem origem.
    }
  }
  return failure({
    kind: "declined",
    external_ref: id,
    ...context,
    ...errorReason(error),
    started_at: new Date(eventAt).toISOString(),
    occurred_at: new Date(eventAt).toISOString(),
    delay_minutes: DECLINE_DELAY_MINUTES,
  });
}

/** PaymentIntent de fatura de assinatura: a falha entra pelo invoice.payment_failed. */
function isInvoicePayment(pi: Obj): boolean {
  const orderRef = str(obj(pi.payment_details)?.order_reference);
  return Boolean(idOf(pi.invoice)) || Boolean(orderRef?.startsWith("in_")) || /^Subscription /.test(str(pi.description) ?? "");
}

async function fromPaymentFailed(pi: Obj, apiKey: string | null, eventAt: number): Promise<NormalizeResult> {
  const id = str(pi.id);
  if (!id) throw new Error("PaymentIntent da Stripe sem id.");
  if (isInvoicePayment(pi)) return ignored("Recusa de fatura: entra pelo invoice.payment_failed.");
  const error = obj(pi.last_payment_error);
  const email = str(obj(obj(error?.payment_method)?.billing_details)?.email) ?? str(pi.receipt_email);
  let context: Partial<NormalizedCheckoutFailure> = {
    amount_cents: cents(pi.amount) ?? 0,
    currency: currencyOf(pi.currency),
    customer_email_hash: await emailHash(pi, email),
    person_ref: personRef(pi.metadata),
    product_name: cleanText(obj(pi.metadata)?.product_name, 200) ?? cleanText(obj(pi.metadata)?.plan, 200),
    ...utmsFrom(pi.metadata),
  };
  if (apiKey) {
    try {
      const session = firstOfList(await stripeGet(apiKey, "/checkout/sessions", { payment_intent: id, limit: "1" }));
      if (session) {
        const fromSession = await sessionContext(session, apiKey);
        context = {
          ...fromSession,
          customer_email_hash: fromSession.customer_email_hash ?? context.customer_email_hash,
          person_ref: fromSession.person_ref ?? context.person_ref,
        };
      }
    } catch {
      // Sem a sessão, fica com o que o PaymentIntent traz.
    }
  }
  return failure({
    kind: "declined",
    external_ref: id,
    ...context,
    ...errorReason(error),
    started_at: new Date(eventAt).toISOString(),
    occurred_at: new Date(eventAt).toISOString(),
    delay_minutes: DECLINE_DELAY_MINUTES,
  });
}

/** Motivo da recusa de uma fatura (basil+: Invoice Payments → PaymentIntent). Melhor esforço. */
async function invoiceDeclineReason(invoice: Obj, apiKey: string | null) {
  let piId = idOf(invoice.payment_intent);
  try {
    if (!piId && apiKey && str(invoice.id)) {
      const payment = firstOfList(await stripeGet(apiKey, "/invoice_payments", { invoice: String(invoice.id), limit: "1" }));
      piId = idOf(obj(payment?.payment)?.payment_intent);
    }
    if (piId && apiKey) return errorReason(obj((await stripeGet(apiKey, `/payment_intents/${piId}`, {})).last_payment_error));
  } catch {
    // A chave pode não ter leitura de PaymentIntents: o aviso sai sem o motivo.
  }
  return { reason_code: null, reason_message: null };
}

async function fromInvoiceFailed(invoice: Obj, apiKey: string | null, eventAt: number): Promise<NormalizeResult> {
  const id = str(invoice.id);
  if (!id) throw new Error("Fatura da Stripe sem id.");
  const amount = cents(invoice.amount_due) ?? 0;
  if (amount === 0) return ignored("Fatura de valor zero.");
  const parent = obj(invoice.parent);
  const subscriptionDetails = obj(parent?.subscription_details) ?? obj(invoice.subscription_details);
  const subscriptionId = idOf(subscriptionDetails?.subscription) ?? idOf(invoice.subscription);
  if (!subscriptionId) return ignored("Fatura avulsa recusada.");

  let tracking: Partial<NormalizedCheckoutFailure> = {};
  try {
    tracking = await subscriptionTracking(subscriptionDetails?.metadata, subscriptionId, apiKey);
  } catch {
    tracking = { ...utmsFrom(subscriptionDetails?.metadata), person_ref: personRef(subscriptionDetails?.metadata) };
  }
  const { fbc: _fbc, fbp: _fbp, client_user_agent: _ua, ...origin } = tracking as Record<string, unknown>;
  const product = invoiceProduct(invoice);
  return failure({
    kind: invoice.billing_reason === "subscription_create" ? "declined" : "renewal_failed",
    external_ref: id,
    subscription_ref: subscriptionId,
    ...(origin as Partial<NormalizedCheckoutFailure>),
    amount_cents: amount,
    currency: currencyOf(invoice.currency),
    external_product_id: product.id,
    product_name: product.name,
    customer_email_hash: await emailHash(invoice, str(invoice.customer_email)),
    ...(await invoiceDeclineReason(invoice, apiKey)),
    started_at: new Date(eventAt).toISOString(),
    occurred_at: new Date(eventAt).toISOString(),
  });
}

/** A Checkout Session foi concluída (a pessoa acertou o cartão depois da recusa)? */
export async function stripeSessionCompleted(secret: string | null, sessionId: string): Promise<boolean | null> {
  const apiKey = parseStripeSecret(secret)?.apiKey;
  if (!apiKey) return null;
  const session = await stripeGet(apiKey, `/checkout/sessions/${encodeURIComponent(sessionId)}`, {});
  return session.status === "complete";
}

const PII_KEYS = [
  "customer_details",
  "billing_details",
  "customer_name",
  "customer_address",
  "customer_phone",
  "customer_shipping",
  "shipping",
  "shipping_details",
  "collected_information",
  "evidence",
  "payment_method_details",
  "receipt_email",
];

/** E-mail que a recusa traz no cartão (last_setup_error/last_payment_error.payment_method). */
function errorEmail(object: Obj): string | null {
  for (const key of ["last_setup_error", "last_payment_error"]) {
    const email = str(obj(obj(obj(object[key])?.payment_method)?.billing_details)?.email);
    if (email) return email;
  }
  return null;
}

/** Tira o cartão (com nome, endereço e e-mail) do erro da recusa; fica só o motivo. */
function withoutPaymentMethod(error: unknown): unknown {
  const e = obj(error);
  if (!e) return error;
  const { payment_method: _pm, source: _source, ...rest } = e;
  return rest;
}

export const stripeAdapter: CheckoutAdapter = {
  provider: "stripe",
  requiresSecret: true,

  async verify({ rawBody, headers, secret }) {
    const keys = parseStripeSecret(secret);
    if (!keys) return { ok: false, reason: "Integração sem signing secret (whsec_...) configurado." };
    const header = headers.get("stripe-signature");
    if (!header) return { ok: false, reason: "Requisição sem o cabeçalho Stripe-Signature." };

    let timestamp: string | null = null;
    const signatures: string[] = [];
    for (const part of header.split(",")) {
      const [key, value] = part.split("=", 2).map((v) => v?.trim());
      if (key === "t" && value) timestamp = value;
      if (key === "v1" && value) signatures.push(value.toLowerCase());
    }
    if (!timestamp || signatures.length === 0) return { ok: false, reason: "Cabeçalho Stripe-Signature malformado." };
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) {
      return { ok: false, reason: "Assinatura da Stripe expirada (mais de 5 minutos)." };
    }

    const expected = await hmacHex("SHA-256", keys.webhookSecret, `${timestamp}.${rawBody}`);
    return signatures.some((s) => timingSafeEqual(s, expected))
      ? { ok: true }
      : { ok: false, reason: "Assinatura inválida: confira o signing secret do endpoint na Stripe." };
  },

  async redact(payload) {
    const event = obj(payload);
    const data = obj(event?.data);
    const object = obj(data?.object);
    if (!event || !data || !object) return payload;
    const copy: Obj = { ...object };
    const details = obj(copy.customer_details);
    const email =
      str(details?.email) ??
      str(copy.customer_email) ??
      str(obj(copy.billing_details)?.email) ??
      errorEmail(copy) ??
      str(copy.receipt_email);
    for (const key of PII_KEYS) delete copy[key];
    for (const key of ["last_setup_error", "last_payment_error"]) {
      if (key in copy) copy[key] = withoutPaymentMethod(copy[key]);
    }
    if ("customer_email" in copy || email) {
      delete copy.customer_email;
      copy.customer_email_sha256 = await hashEmail(email);
    }
    // Não guardar data.previous_attributes, que pode repetir dados pessoais.
    return { ...event, data: { object: copy } };
  },

  summarize(payload) {
    const event = obj(payload);
    const object = obj(obj(event?.data)?.object);
    return {
      eventType: cleanText(event?.type, 100),
      externalOrderId: cleanText(idOf(object?.payment_intent) ?? object?.id, 200),
    };
  },

  async normalize(payload, context): Promise<NormalizeResult> {
    const event = obj(payload);
    const type = str(event?.type);
    const object = obj(obj(event?.data)?.object);
    if (!type || !object) throw new Error("Evento da Stripe fora do formato esperado (sem type ou data.object).");
    const apiKey = parseStripeSecret(context?.secret ?? null)?.apiKey ?? null;
    const eventAt = unixToMs(event?.created);

    switch (type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
        return fromCheckoutSession(type, object, apiKey);
      case "invoice.paid":
        return fromInvoice(object, apiKey);
      case "charge.refunded":
        return fromRefundedCharge(object);
      case "charge.dispute.created":
        return fromDispute(object, apiKey);
      case "checkout.session.expired":
        return fromExpiredSession(object, apiKey);
      case "setup_intent.setup_failed":
        return fromSetupFailed(object, apiKey, eventAt);
      case "payment_intent.payment_failed":
        return fromPaymentFailed(object, apiKey, eventAt);
      case "invoice.payment_failed":
        return fromInvoiceFailed(object, apiKey, eventAt);
      default:
        return ignored(`Evento ${type} não altera vendas.`);
    }
  },
};
