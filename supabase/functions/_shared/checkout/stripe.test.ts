import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseStripeSecret, stripeAdapter } from "./stripe.ts";
import { hmacHex, sha256Hex } from "../crypto.ts";

const invoicePaid = readFileSync(resolve(__dirname, "../../webhooks/fixtures/stripe-invoice-paid.json"), "utf8");
const SECRET = JSON.stringify({ webhook_secret: "whsec_teste123", api_key: "rk_test_123" });

async function signedHeaders(body: string, secret = "whsec_teste123", at = Math.floor(Date.now() / 1000)) {
  const signature = await hmacHex("SHA-256", secret, `${at}.${body}`);
  return new Headers({ "stripe-signature": `t=${at},v1=${signature},v0=ignorado` });
}

function verify(body: string, headers: Headers, secret: string | null = SECRET) {
  return stripeAdapter.verify({ rawBody: body, url: new URL("https://x/webhooks/stripe/t"), headers, secret });
}

function event(type: string, object: Record<string, unknown>) {
  return { id: "evt_1", object: "event", type, data: { object } };
}

/** Simula a API da Stripe: cada rota devolve o JSON informado. */
function mockStripeApi(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}?${url.searchParams}`);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer rk_test_123");
      const body = routes[url.pathname];
      return new Response(JSON.stringify(body ?? { error: { message: "not found" } }), { status: body ? 200 : 404 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("Stripe: segredo", () => {
  it("lê o JSON com as duas chaves ou só o whsec_", () => {
    expect(parseStripeSecret(SECRET)).toEqual({ webhookSecret: "whsec_teste123", apiKey: "rk_test_123" });
    expect(parseStripeSecret("whsec_abc")).toEqual({ webhookSecret: "whsec_abc", apiKey: null });
    expect(parseStripeSecret('{"api_key":"rk"}')).toBeNull();
    expect(parseStripeSecret(null)).toBeNull();
  });
});

describe("Stripe: assinatura", () => {
  it("aceita o cabeçalho Stripe-Signature correto", async () => {
    expect(await verify(invoicePaid, await signedHeaders(invoicePaid))).toEqual({ ok: true });
  });

  it("rejeita segredo errado, corpo alterado, assinatura antiga e cabeçalho ausente", async () => {
    expect((await verify(invoicePaid, await signedHeaders(invoicePaid, "whsec_outro"))).ok).toBe(false);
    expect((await verify(invoicePaid + " ", await signedHeaders(invoicePaid))).ok).toBe(false);
    const old = Math.floor(Date.now() / 1000) - 10 * 60;
    expect((await verify(invoicePaid, await signedHeaders(invoicePaid, "whsec_teste123", old))).ok).toBe(false);
    expect((await verify(invoicePaid, new Headers())).ok).toBe(false);
    expect((await verify(invoicePaid, await signedHeaders(invoicePaid), null)).ok).toBe(false);
  });
});

describe("Stripe: normalização", () => {
  it("fatura de assinatura: resolve o PaymentIntent e as UTMs da Checkout Session", async () => {
    const calls = mockStripeApi({
      "/v1/invoice_payments": { data: [{ payment: { type: "payment_intent", payment_intent: "pi_123" } }] },
      "/v1/checkout/sessions": {
        data: [{ metadata: { utm_source: "FB", utm_campaign: "Black Friday|120200000000000000", utm_content: "Vídeo|120222" } }],
      },
    });
    const result = await stripeAdapter.normalize(JSON.parse(invoicePaid), { secret: SECRET });
    expect(result.kind).toBe("sale");
    if (result.kind !== "sale") return;
    expect(result.sale).toMatchObject({
      external_order_id: "pi_123",
      status: "approved",
      gross_amount_cents: 7800,
      currency: "BRL",
      external_product_id: "prod_Business",
      product_name: "1 × FreelaPro Business (at R$ 78,00 / month)",
      utm_source: "FB",
      utm_campaign: "Black Friday|120200000000000000",
      utm_content: "Vídeo|120222",
      paid_at: new Date(1792980000 * 1000).toISOString(),
    });
    expect(result.sale.customer_email_hash).toBe(await sha256Hex("cliente.stripe@exemplo.com"));
    expect(calls[0]).toContain("invoice=in_1TesteFatura");
    expect(calls[1]).toContain("subscription=sub_1TesteAssinatura");
  });

  it("fatura com UTMs na assinatura não consulta a Checkout Session", async () => {
    const calls = mockStripeApi({ "/v1/invoice_payments": { data: [] } });
    const payload = JSON.parse(invoicePaid);
    payload.data.object.parent.subscription_details.metadata = { utm_source: "ig" };
    const result = await stripeAdapter.normalize(payload, { secret: SECRET });
    expect(result.kind === "sale" && result.sale.utm_source).toBe("ig");
    // Sem pagamento encontrado, a fatura vira o identificador.
    expect(result.kind === "sale" && result.sale.external_order_id).toBe("in_1TesteFatura");
    expect(calls).toHaveLength(1);
  });

  it("ignora Checkout Session de assinatura com cobrança e fatura zerada de renovação", async () => {
    const session = event("checkout.session.completed", {
      id: "cs_1",
      mode: "subscription",
      payment_status: "paid",
      amount_total: 7800,
      subscription: "sub_1",
    });
    expect((await stripeAdapter.normalize(session, { secret: SECRET })).kind).toBe("ignored");
    const payload = JSON.parse(invoicePaid);
    payload.data.object.amount_paid = 0;
    payload.data.object.billing_reason = "subscription_cycle";
    expect((await stripeAdapter.normalize(payload, { secret: SECRET })).kind).toBe("ignored");
  });

  it("checkout de assinatura sem cobrança vira teste iniciado, com as UTMs da sessão", async () => {
    mockStripeApi({
      "/v1/checkout/sessions/cs_trial/line_items": { data: [{ description: "Drinfy Pro", price: { product: "prod_D" } }] },
    });
    const result = await stripeAdapter.normalize(
      event("checkout.session.completed", {
        id: "cs_trial",
        mode: "subscription",
        payment_status: "no_payment_required",
        amount_total: 0,
        currency: "brl",
        subscription: "sub_trial",
        customer_details: { email: "a@b.com" },
        metadata: { utm_source: "FB", utm_campaign: "Teste|120200000000000001" },
      }),
      { secret: SECRET },
    );
    expect(result).toMatchObject({
      kind: "sale",
      sale: {
        external_order_id: "sub_trial",
        subscription_ref: "sub_trial",
        status: "trialing",
        gross_amount_cents: 0,
        paid_at: null,
        product_name: "Drinfy Pro",
        external_product_id: "prod_D",
        utm_campaign: "Teste|120200000000000001",
      },
    });
  });

  it("primeira fatura zerada da assinatura também abre o teste", async () => {
    const calls = mockStripeApi({
      "/v1/checkout/sessions": { data: [{ metadata: { utm_source: "ig" } }] },
    });
    const payload = JSON.parse(invoicePaid);
    payload.data.object.amount_paid = 0;
    payload.data.object.billing_reason = "subscription_create";
    const result = await stripeAdapter.normalize(payload, { secret: SECRET });
    expect(result).toMatchObject({
      kind: "sale",
      sale: { external_order_id: "sub_1TesteAssinatura", status: "trialing", utm_source: "ig", paid_at: null },
    });
    // Sem cobrança não há pagamento para procurar.
    expect(calls.some((c) => c.startsWith("/v1/invoice_payments"))).toBe(false);
  });

  it("fatura paga leva a assinatura para converter o teste", async () => {
    mockStripeApi({
      "/v1/invoice_payments": { data: [{ payment: { type: "payment_intent", payment_intent: "pi_123" } }] },
      "/v1/checkout/sessions": { data: [] },
    });
    const result = await stripeAdapter.normalize(JSON.parse(invoicePaid), { secret: SECRET });
    expect(result.kind === "sale" && result.sale.subscription_ref).toBe("sub_1TesteAssinatura");
  });

  it("pagamento avulso pela Checkout Session", async () => {
    mockStripeApi({
      "/v1/checkout/sessions/cs_1/line_items": { data: [{ description: "Mentoria", price: { product: "prod_M" } }] },
    });
    const result = await stripeAdapter.normalize(
      event("checkout.session.completed", {
        id: "cs_1",
        mode: "payment",
        payment_status: "paid",
        payment_intent: "pi_avulso",
        amount_total: 49700,
        currency: "brl",
        created: 1792980000,
        customer_details: { email: "a@b.com" },
        metadata: { utm_source: "FB", utm_term: "lookalike" },
      }),
      { secret: SECRET },
    );
    expect(result).toMatchObject({
      kind: "sale",
      sale: {
        external_order_id: "pi_avulso",
        status: "approved",
        gross_amount_cents: 49700,
        product_name: "Mentoria",
        external_product_id: "prod_M",
        utm_term: "lookalike",
      },
    });
  });

  it("boleto/pix aguardando fica pendente; falha vira cancelada", async () => {
    const base = { id: "cs_2", mode: "payment", payment_intent: "pi_2", amount_total: 100, metadata: { product_name: "X", product_id: "p" } };
    const pending = await stripeAdapter.normalize(event("checkout.session.completed", { ...base, payment_status: "unpaid" }));
    expect(pending.kind === "sale" && pending.sale.status).toBe("pending");
    const failed = await stripeAdapter.normalize(event("checkout.session.async_payment_failed", base));
    expect(failed.kind === "sale" && failed.sale.status).toBe("canceled");
  });

  it("reembolso total e chargeback usam o PaymentIntent; parcial é ignorado", async () => {
    const refund = await stripeAdapter.normalize(
      event("charge.refunded", { id: "ch_1", payment_intent: "pi_123", amount: 7800, currency: "brl", refunded: true }),
    );
    expect(refund).toMatchObject({ kind: "sale", sale: { external_order_id: "pi_123", status: "refunded" } });
    const partial = await stripeAdapter.normalize(event("charge.refunded", { id: "ch_1", payment_intent: "pi_123", refunded: false }));
    expect(partial.kind).toBe("ignored");
    const dispute = await stripeAdapter.normalize(
      event("charge.dispute.created", { id: "dp_1", charge: "ch_1", payment_intent: "pi_123", amount: 7800 }),
    );
    expect(dispute).toMatchObject({ kind: "sale", sale: { external_order_id: "pi_123", status: "chargeback" } });
  });

  it("ignora eventos que não mudam vendas", async () => {
    expect((await stripeAdapter.normalize(event("customer.created", { id: "cus_1" }))).kind).toBe("ignored");
  });
});

describe("Stripe: LGPD", () => {
  it("remove dados pessoais e guarda só o hash do e-mail", async () => {
    const redacted = (await stripeAdapter.redact(JSON.parse(invoicePaid))) as { data: { object: Record<string, unknown> } };
    const text = JSON.stringify(redacted);
    expect(text).not.toContain("Exemplo.com");
    expect(text).not.toContain("Cliente Teste");
    expect(redacted.data.object.customer_email_sha256).toBe(await sha256Hex("cliente.stripe@exemplo.com"));
    // O que a normalização precisa continua lá, inclusive o hash do e-mail.
    expect(redacted.data.object.amount_paid).toBe(7800);
    mockStripeApi({ "/v1/invoice_payments": { data: [] }, "/v1/checkout/sessions": { data: [] } });
    const result = await stripeAdapter.normalize(redacted, { secret: SECRET });
    expect(result.kind === "sale" && result.sale.customer_email_hash).toBe(await sha256Hex("cliente.stripe@exemplo.com"));
  });
});

describe("Stripe: dados de clique da Meta", () => {
  it("lê fbc, fbp e user agent do metadata da Checkout Session", async () => {
    mockStripeApi({});
    const result = await stripeAdapter.normalize(
      event("checkout.session.completed", {
        id: "cs_9",
        mode: "payment",
        payment_status: "paid",
        payment_intent: "pi_9",
        amount_total: 100,
        created: 1792980000,
        metadata: {
          product_name: "X",
          product_id: "p",
          fbclid: "IwAR-cliqueDoAnuncio",
          fbp: "fb.1.1792970000000.1234567",
          client_user_agent: "Mozilla/5.0 (iPhone)",
        },
      }),
      { secret: SECRET },
    );
    expect(result).toMatchObject({
      kind: "sale",
      sale: {
        fbc: "fb.1.1792980000000.IwAR-cliqueDoAnuncio",
        fbp: "fb.1.1792970000000.1234567",
        client_user_agent: "Mozilla/5.0 (iPhone)",
      },
    });
  });

  it("renovação pega os dados de clique da assinatura", async () => {
    mockStripeApi({ "/v1/invoice_payments": { data: [] } });
    const payload = JSON.parse(invoicePaid);
    payload.data.object.parent.subscription_details.metadata = { utm_source: "FB", fbc: "fb.1.1792970000000.abc" };
    const result = await stripeAdapter.normalize(payload, { secret: SECRET });
    expect(result.kind === "sale" && result.sale.fbc).toBe("fb.1.1792970000000.abc");
  });
});
