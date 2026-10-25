import { z } from "zod";
import { hashEmail, hmacHex, timingSafeEqual } from "../crypto.ts";
import { cleanText, parseCents, parseProviderDate } from "../values.ts";
import type { CheckoutAdapter, NormalizeResult, SaleStatus } from "./types.ts";

/**
 * Kiwify (https://docs.kiwify.com.br/api-reference/webhooks/receiving):
 * - Assinatura: HMAC-SHA1 (hex) do corpo bruto com o token do webhook, no query param `signature`.
 * - Datas da raiz em horário de Brasília, "YYYY-MM-DD HH:mm".
 * - order_status: waiting_payment | paid | refused | refunded | chargedback.
 * Os blocos Customer, Product, Commissions e TrackingParameters aceitam também os nomes
 * do objeto de venda da API (customer, product, payment, tracking).
 */

const STATUS_MAP: Record<string, SaleStatus> = {
  paid: "approved",
  approved: "approved",
  waiting_payment: "pending",
  pending: "pending",
  refused: "canceled",
  canceled: "canceled",
  refunded: "refunded",
  chargedback: "chargeback",
  chargeback: "chargeback",
};

// Eventos sobre a assinatura (não sobre um pedido): não mudam a venda.
const IGNORED_EVENTS = new Set(["subscription_canceled", "subscription_late"]);

const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape).partial().passthrough().nullish();
const text = z.union([z.string(), z.number()]).nullish();

const trackingShape = {
  utm_source: text,
  utm_medium: text,
  utm_campaign: text,
  utm_content: text,
  utm_term: text,
  src: text,
  sck: text,
};

const payloadSchema = z
  .object({
    order_id: z.union([z.string().min(1), z.number()]),
    order_ref: text,
    order_status: z.string().min(1),
    webhook_event_type: z.string().nullish(),
    approved_date: z.string().nullish(),
    refunded_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    created_at: z.string().nullish(),
    Product: loose({ product_id: text, product_name: text }),
    product: loose({ id: text, name: text }),
    Commissions: loose({
      charge_amount: text,
      product_base_price: text,
      my_commission: text,
      currency: z.string().nullish(),
      charge_currency: z.string().nullish(),
    }),
    payment: loose({ charge_amount: text, net_amount: text, charge_currency: z.string().nullish() }),
    Customer: loose({ email: z.string().nullish(), email_sha256: z.string().nullish() }),
    customer: loose({ email: z.string().nullish(), email_sha256: z.string().nullish() }),
    TrackingParameters: loose(trackingShape),
    tracking: loose(trackingShape),
  })
  .passthrough();

type KiwifyPayload = z.infer<typeof payloadSchema>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function redactCustomer(value: unknown): Promise<unknown> {
  const customer = asRecord(value);
  if (!customer) return value;
  const email = typeof customer.email === "string" ? customer.email : null;
  return {
    email_sha256: (await hashEmail(email)) ?? customer.email_sha256 ?? null,
    country: customer.country ?? null,
  };
}

export const kiwifyAdapter: CheckoutAdapter = {
  provider: "kiwify",
  requiresSecret: true,

  async verify({ rawBody, url, secret }) {
    if (!secret) return { ok: false, reason: "Integração sem token configurado." };
    const received = url.searchParams.get("signature")?.trim().toLowerCase();
    if (!received) return { ok: false, reason: "Requisição sem o parâmetro signature." };
    const expected = await hmacHex("SHA-1", secret, rawBody);
    return timingSafeEqual(received, expected)
      ? { ok: true }
      : { ok: false, reason: "Assinatura inválida: confira o token do webhook na Kiwify." };
  },

  async redact(payload) {
    const record = asRecord(payload);
    if (!record) return payload;
    const copy: Record<string, unknown> = { ...record };
    if ("Customer" in copy) copy.Customer = await redactCustomer(copy.Customer);
    if ("customer" in copy) copy.customer = await redactCustomer(copy.customer);
    return copy;
  },

  summarize(payload) {
    const record = asRecord(payload);
    return {
      eventType: cleanText(record?.webhook_event_type, 100),
      externalOrderId: cleanText(record?.order_id, 200),
    };
  },

  async normalize(payload): Promise<NormalizeResult> {
    const record = asRecord(payload);
    if (!record || record.order_id == null) {
      return { kind: "ignored", reason: "Evento sem pedido (ex.: carrinho abandonado)." };
    }

    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Payload da Kiwify fora do formato esperado (${issue?.path.join(".")}: ${issue?.message}).`);
    }
    const p: KiwifyPayload = parsed.data;

    if (p.webhook_event_type && IGNORED_EVENTS.has(p.webhook_event_type)) {
      return { kind: "ignored", reason: `Evento de assinatura (${p.webhook_event_type}) não altera a venda.` };
    }

    const status = STATUS_MAP[p.order_status.toLowerCase()];
    if (!status) throw new Error(`Status da Kiwify desconhecido: "${p.order_status}".`);

    const gross =
      parseCents(p.Commissions?.charge_amount) ??
      parseCents(p.payment?.charge_amount) ??
      parseCents(p.Commissions?.product_base_price);
    if (gross === null) throw new Error("Payload da Kiwify sem valor da venda (Commissions.charge_amount).");

    const tracking = p.TrackingParameters ?? p.tracking ?? {};
    const customer = p.Customer ?? p.customer ?? {};
    const emailHash =
      (await hashEmail(customer.email)) ??
      (typeof customer.email_sha256 === "string" && /^[0-9a-f]{64}$/.test(customer.email_sha256)
        ? customer.email_sha256
        : null);

    const approvedAt = parseProviderDate(p.approved_date);
    const refundedAt =
      parseProviderDate(p.refunded_at) ??
      (status === "refunded" || status === "chargeback" ? parseProviderDate(p.updated_at) : null);

    return {
      kind: "sale",
      sale: {
        external_order_id: String(p.order_id),
        status,
        gross_amount_cents: gross,
        net_amount_cents: parseCents(p.Commissions?.my_commission) ?? parseCents(p.payment?.net_amount),
        currency: (p.Commissions?.currency ?? p.Commissions?.charge_currency ?? p.payment?.charge_currency ?? "BRL")
          .toUpperCase()
          .slice(0, 3),
        external_product_id: cleanText(p.Product?.product_id ?? p.product?.id, 200),
        product_name: cleanText(p.Product?.product_name ?? p.product?.name, 200),
        customer_email_hash: emailHash,
        utm_source: cleanText(tracking.utm_source),
        utm_medium: cleanText(tracking.utm_medium),
        utm_campaign: cleanText(tracking.utm_campaign),
        utm_content: cleanText(tracking.utm_content),
        utm_term: cleanText(tracking.utm_term),
        paid_at: status === "pending" || status === "canceled" ? null : approvedAt,
        refunded_at: refundedAt,
      },
    };
  },
};
