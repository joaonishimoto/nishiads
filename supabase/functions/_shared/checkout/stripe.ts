/**
 * Stripe: webhook assinado (Stripe-Signature, HMAC-SHA256) + chave restrita só de leitura.
 *
 * A venda é identificada pelo PaymentIntent (pi_...), que aparece no pagamento avulso, no
 * reembolso e no chargeback. Desde a API 2025-03-31.basil a fatura de assinatura não traz
 * mais o PaymentIntent no webhook, então a chave de API resolve fatura → pagamento e busca
 * as UTMs da Checkout Session que criou a assinatura.
 */
import { hashEmail, hmacHex, timingSafeEqual } from "../crypto.ts";
import { cleanText } from "../values.ts";
import type { CheckoutAdapter, NormalizeResult, NormalizedSale, SaleStatus } from "./types.ts";

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const STRIPE_API = "https://api.stripe.com/v1";
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

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
  if (mode === "subscription") return ignored("Assinatura: a venda entra pelo evento invoice.paid.");
  if (mode !== "payment") return ignored(`Checkout Session em modo ${mode ?? "desconhecido"}.`);

  const paymentIntent = idOf(session.payment_intent);
  if (!paymentIntent) return ignored("Checkout Session sem PaymentIntent.");

  let status: SaleStatus;
  if (type === "checkout.session.async_payment_failed") status = "canceled";
  else if (type === "checkout.session.async_payment_succeeded" || session.payment_status === "paid") status = "approved";
  else status = "pending";

  const metadata = obj(session.metadata);
  let productName = cleanText(metadata?.product_name, 200);
  let productId = cleanText(metadata?.product_id, 200);
  if ((!productName || !productId) && apiKey && str(session.id)) {
    const line = firstOfList(await stripeGet(apiKey, `/checkout/sessions/${session.id}/line_items`, { limit: "1" }));
    productName ??= cleanText(line?.description, 200);
    productId ??= idOf(obj(line?.price)?.product);
  }

  const details = obj(session.customer_details);
  return {
    kind: "sale",
    sale: baseSale({
      external_order_id: paymentIntent,
      status,
      gross_amount_cents: cents(session.amount_total) ?? 0,
      currency: currencyOf(session.currency),
      external_product_id: productId,
      product_name: productName,
      customer_email_hash: await emailHash(session, str(details?.email) ?? str(session.customer_email)),
      ...utmsFrom(session.metadata),
      paid_at: status === "approved" ? (unixToIso(session.created) ?? new Date().toISOString()) : null,
    }),
  };
}

async function fromInvoice(invoice: Obj, apiKey: string | null): Promise<NormalizeResult> {
  const amountPaid = cents(invoice.amount_paid) ?? 0;
  if (amountPaid === 0) return ignored("Fatura de valor zero (ex.: período de teste).");
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

  const parent = obj(invoice.parent);
  const subscriptionDetails = obj(parent?.subscription_details) ?? obj(invoice.subscription_details);
  const subscriptionId = idOf(subscriptionDetails?.subscription) ?? idOf(invoice.subscription);
  let utms = utmsFrom(subscriptionDetails?.metadata);
  if (!hasUtm(utms) && apiKey && subscriptionId) {
    const session = firstOfList(
      await stripeGet(apiKey, "/checkout/sessions", { subscription: subscriptionId, limit: "1" }),
    );
    utms = utmsFrom(session?.metadata);
  }

  const lines = obj(invoice.lines);
  const line = Array.isArray(lines?.data) ? obj(lines.data[0]) : null;
  const priceDetails = obj(obj(line?.pricing)?.price_details);
  const productId = idOf(priceDetails?.product) ?? idOf(obj(line?.price)?.product);

  return {
    kind: "sale",
    sale: baseSale({
      external_order_id: paymentIntent ?? invoiceId,
      status: "approved",
      gross_amount_cents: amountPaid,
      currency: currencyOf(invoice.currency),
      external_product_id: productId,
      product_name: cleanText(line?.description, 200),
      customer_email_hash: await emailHash(invoice, str(invoice.customer_email)),
      ...utms,
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
];

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
    const email = str(details?.email) ?? str(copy.customer_email) ?? str(obj(copy.billing_details)?.email);
    for (const key of PII_KEYS) delete copy[key];
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
      default:
        return ignored(`Evento ${type} não altera vendas.`);
    }
  },
};
