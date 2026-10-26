import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../crypto.ts";
import { clickIdsFrom } from "../checkout/click-ids.ts";
import { GRAPH_API_VERSION } from "./graph.ts";
import {
  buildServerEvent,
  buildTestEvent,
  friendlyCapiError,
  isRenewal,
  retryDelaySeconds,
  sendServerEvent,
  type CapiSale,
} from "./capi.ts";
import { deliverDueEvents } from "./capi-delivery.ts";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const EMAIL_HASH = "a".repeat(64);
const CREDS = {
  pixel_id: "1234567890123",
  access_token: "EAAB-token",
  event_source_url: "https://drinfy.com.br",
  test_event_code: null as string | null,
};

function sale(overrides: Partial<CapiSale> = {}): CapiSale {
  return {
    id: "s1",
    external_order_id: "pi_123",
    gross_amount_cents: 9790,
    currency: "brl",
    external_product_id: "prod_1",
    product_name: "Drinfy Pro",
    customer_email_hash: EMAIL_HASH,
    fbc: "fb.1.1761480000000.IwAR-abc",
    fbp: "fb.1.1761480000000.987654321",
    client_user_agent: "Mozilla/5.0",
    raw_payload: {
      data: { object: { customer: "cus_ABC", billing_reason: "subscription_create" } },
    },
    ...overrides,
  };
}

const row = (overrides: Record<string, unknown> = {}) => ({
  event_name: "Purchase" as const,
  event_id: "pi_123",
  event_time: "2026-10-26T11:59:00Z",
  ...overrides,
});

describe("Conversions API: evento", () => {
  it("monta o Purchase com dedup, hash e dados de clique sem hash", async () => {
    const result = await buildServerEvent(row(), sale(), CREDS, { now: NOW });
    expect(result.kind).toBe("event");
    if (result.kind !== "event") return;
    expect(result.event).toEqual({
      event_name: "Purchase",
      event_time: Math.floor(Date.parse("2026-10-26T11:59:00Z") / 1000),
      event_id: "pi_123",
      action_source: "website",
      event_source_url: "https://drinfy.com.br",
      user_data: {
        em: [EMAIL_HASH],
        external_id: [await sha256Hex("cus_ABC")],
        fbc: "fb.1.1761480000000.IwAR-abc",
        fbp: "fb.1.1761480000000.987654321",
        client_user_agent: "Mozilla/5.0",
      },
      custom_data: {
        currency: "BRL",
        value: 97.9,
        order_id: "pi_123",
        content_ids: ["prod_1"],
        content_type: "product",
        contents: [{ id: "prod_1", quantity: 1, item_price: 97.9 }],
        content_name: "Drinfy Pro",
      },
    });
  });

  it("renovação vai como system_generated, sem URL do site", async () => {
    const renewal = sale({
      raw_payload: { data: { object: { billing_reason: "subscription_cycle" } } },
    });
    expect(isRenewal(renewal.raw_payload)).toBe(true);
    const result = await buildServerEvent(row(), renewal, CREDS, { now: NOW });
    expect(result.kind === "event" && result.event.action_source).toBe("system_generated");
    expect(result.kind === "event" && result.event.event_source_url).toBeUndefined();
  });

  it("StartTrial tem valor zero; sem cliente da Stripe o external_id é o hash do e-mail", async () => {
    const result = await buildServerEvent(
      row({ event_name: "StartTrial" }),
      sale({ raw_payload: {} }),
      CREDS,
      { now: NOW },
    );
    if (result.kind !== "event") throw new Error("esperava evento");
    expect(result.event.custom_data.value).toBe(0);
    expect(result.event.user_data.external_id).toEqual([EMAIL_HASH]);
  });

  it("pula evento com mais de 7 dias e venda sem nenhum dado do comprador", async () => {
    const old = await buildServerEvent(row({ event_time: "2026-10-19T11:00:00Z" }), sale(), CREDS, {
      now: NOW,
    });
    expect(old.kind).toBe("skip");
    const empty = await buildServerEvent(
      row(),
      sale({ customer_email_hash: null, fbc: null, fbp: null, raw_payload: {} }),
      CREDS,
      { now: NOW },
    );
    expect(empty).toMatchObject({ kind: "skip" });
  });

  it("data futura é limitada a agora", async () => {
    const result = await buildServerEvent(
      row({ event_time: "2026-10-27T00:00:00Z" }),
      sale(),
      CREDS,
      { now: NOW },
    );
    expect(result.kind === "event" && result.event.event_time).toBe(NOW / 1000);
  });

  it("evento de teste não usa dados reais", async () => {
    const event = await buildTestEvent(CREDS, NOW);
    expect(event.event_id).toMatch(/^teste-/);
    expect(event.user_data.em).toEqual([await sha256Hex("teste@nishiads.dev")]);
    expect(event.custom_data).toMatchObject({ value: 1, currency: "BRL" });
  });
});

describe("Conversions API: envio", () => {
  it("faz POST no pixel com a versão única da Graph API e o código de teste", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: "T" })),
    );
    const event = await buildTestEvent(CREDS, NOW);
    const outcome = await sendServerEvent(
      { ...CREDS, test_event_code: "TEST123" },
      event,
      fetchFn as typeof fetch,
    );
    expect(outcome).toEqual({ ok: true, response: { events_received: 1, fbtrace_id: "T" } });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/1234567890123/events`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      data: [event],
      access_token: "EAAB-token",
      test_event_code: "TEST123",
    });
  });

  it("classifica token, pixel inexistente, parâmetro inválido, limite e rede", async () => {
    const reply = (status: number, error: Record<string, unknown>) =>
      vi.fn(
        async () => new Response(JSON.stringify({ error }), { status }),
      ) as unknown as typeof fetch;
    const event = await buildTestEvent(CREDS, NOW);

    const token = await sendServerEvent(
      CREDS,
      event,
      reply(400, { code: 190, message: "Invalid OAuth access token" }),
    );
    expect(token).toMatchObject({ ok: false, kind: "config", code: 190 });
    if (!token.ok) expect(friendlyCapiError(token)).toContain("Token inválido");

    const pixel = await sendServerEvent(
      CREDS,
      event,
      reply(400, { code: 100, error_subcode: 33, message: "Object does not exist" }),
    );
    expect(pixel).toMatchObject({ ok: false, kind: "config" });
    if (!pixel.ok) expect(friendlyCapiError(pixel)).toContain("Pixel não encontrado");

    const invalid = await sendServerEvent(
      CREDS,
      event,
      reply(400, {
        code: 100,
        message: "Invalid parameter",
        error_user_msg: "client_user_agent is required for website events",
      }),
    );
    expect(invalid).toMatchObject({ ok: false, kind: "other", needsUserAgent: true });

    const limited = await sendServerEvent(
      CREDS,
      event,
      reply(400, { code: 17, message: "User request limit reached" }),
    );
    expect(limited).toMatchObject({ ok: false, kind: "rate_limit" });

    const down = await sendServerEvent(
      CREDS,
      event,
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    );
    expect(down).toMatchObject({ ok: false, kind: "transient" });
  });

  it("retentativas: backoff para erro temporário, 1h para configuração, nenhuma para parâmetro inválido", () => {
    expect(retryDelaySeconds("transient", 1)).toBe(60);
    expect(retryDelaySeconds("rate_limit", 3)).toBe(1800);
    expect(retryDelaySeconds("transient", 7)).toBeNull();
    expect(retryDelaySeconds("config", 20)).toBe(3600);
    expect(retryDelaySeconds("other", 1)).toBeNull();
  });
});

describe("Dados de clique do checkout", () => {
  it("aceita _fbc/_fbp válidos e monta o fbc a partir do fbclid", () => {
    expect(
      clickIdsFrom(
        { fbc: "fb.1.1700000000000.abc", fbp: "fb.1.1700000000000.42", client_user_agent: "UA" },
        NOW,
      ),
    ).toEqual({
      fbc: "fb.1.1700000000000.abc",
      fbp: "fb.1.1700000000000.42",
      client_user_agent: "UA",
    });
    expect(
      clickIdsFrom({ fbclid: "IwAR2F4-dbP0l7Mn1IawQQGCINEz7PYXQvwjNwB_qa2ofrHyiLjcbCRxTDMgk" }, NOW)
        .fbc,
    ).toBe(`fb.1.${NOW}.IwAR2F4-dbP0l7Mn1IawQQGCINEz7PYXQvwjNwB_qa2ofrHyiLjcbCRxTDMgk`);
    // fbc inválido cai para o fbclid; fbp inválido é descartado.
    expect(clickIdsFrom({ fbc: "lixo", fbclid: "abcdefgh123", fbp: "fb.1.x" }, NOW)).toEqual({
      fbc: `fb.1.${NOW}.abcdefgh123`,
      fbp: null,
      client_user_agent: null,
    });
    expect(clickIdsFrom(null, NOW)).toEqual({ fbc: null, fbp: null, client_user_agent: null });
    expect(clickIdsFrom({ fbclid: "curto" }, NOW).fbc).toBeNull();
  });
});

/** Cliente do Supabase falso: só o que a entrega usa. */
function fakeAdmin(state: {
  claimed: Record<string, unknown>[];
  creds?: typeof CREDS | null;
  sale?: CapiSale | null;
}) {
  const updates: { table: string; patch: Record<string, unknown>; filter: unknown }[] = [];
  const inserts: { table: string; row: unknown }[] = [];
  const admin = {
    rpc: vi.fn(async (name: string) => {
      if (name === "service_claim_meta_capi_events") return { data: state.claimed, error: null };
      if (name === "service_meta_capi_credentials")
        return { data: state.creds ? [state.creds] : [], error: null };
      throw new Error(`rpc inesperada ${name}`);
    }),
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.sale ?? null, error: null }) }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, value: unknown) => {
          updates.push({ table, patch, filter: value });
          return { error: null };
        },
        in: async (_col: string, value: unknown) => {
          updates.push({ table, patch, filter: value });
          return { error: null };
        },
      }),
      insert: async (row: unknown) => {
        inserts.push({ table, row });
        return { error: null };
      },
    }),
  };
  return { admin: admin as never, updates, inserts };
}

const claimed = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  workspace_id: "w1",
  sale_id: "s1",
  event_name: "Purchase",
  event_id: "pi_123",
  event_time: new Date(Date.now() - 60_000).toISOString(),
  is_test: false,
  attempts: 0,
  ...overrides,
});

describe("Conversions API: fila", () => {
  it("marca como enviado e atualiza a configuração", async () => {
    const { admin, updates } = fakeAdmin({ claimed: [claimed(1)], creds: CREDS, sale: sale() });
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ events_received: 1 })),
    ) as unknown as typeof fetch;
    const summary = await deliverDueEvents(admin, { fetchFn });
    expect(summary).toMatchObject({ sent: 1, failed: 0 });
    const event = updates.find((u) => u.table === "meta_capi_events");
    expect(event?.patch).toMatchObject({
      status: "sent",
      attempts: 1,
      last_error: null,
      locked_until: null,
    });
    expect(JSON.stringify(event?.patch.request)).not.toContain("EAAB-token");
    expect(
      updates.some((u) => u.table === "meta_capi_configs" && u.patch.last_error === null),
    ).toBe(true);
  });

  it("erro temporário reagenda; parâmetro inválido falha de vez", async () => {
    const transient = fakeAdmin({ claimed: [claimed(1)], creds: CREDS, sale: sale() });
    const down = vi.fn(async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    expect(await deliverDueEvents(transient.admin, { fetchFn: down })).toMatchObject({
      retrying: 1,
    });
    expect(transient.updates[0]?.patch).toMatchObject({ status: "pending", attempts: 1 });

    const invalid = fakeAdmin({ claimed: [claimed(1)], creds: CREDS, sale: sale() });
    const bad = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 100, message: "Invalid parameter" } }), {
          status: 400,
        }),
    ) as unknown as typeof fetch;
    expect(await deliverDueEvents(invalid.admin, { fetchFn: bad })).toMatchObject({ failed: 1 });
    expect(invalid.updates[0]?.patch).toMatchObject({ status: "failed" });
  });

  it("token inválido avisa na configuração e segura os outros eventos do workspace", async () => {
    const { admin, updates } = fakeAdmin({
      claimed: [claimed(1), claimed(2, { event_id: "pi_2" })],
      creds: CREDS,
      sale: sale(),
    });
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 190, message: "expired" } }), { status: 400 }),
    );
    const summary = await deliverDueEvents(admin, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(summary).toMatchObject({ retrying: 1, deferred: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(
      updates.some(
        (u) =>
          u.table === "meta_capi_configs" && String(u.patch.last_error).includes("Token inválido"),
      ),
    ).toBe(true);
  });

  it("sem user agent recusado como site, reenvia como other", async () => {
    const { admin, updates } = fakeAdmin({
      claimed: [claimed(1)],
      creds: CREDS,
      sale: sale({ client_user_agent: null }),
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 100, message: "client_user_agent required" } }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ events_received: 1 })));
    expect(
      await deliverDueEvents(admin, { fetchFn: fetchFn as unknown as typeof fetch }),
    ).toMatchObject({ sent: 1 });
    const second = JSON.parse(
      String((fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1].body),
    );
    expect(second.data[0].action_source).toBe("other");
    expect(
      (updates[0]?.patch.request as { event: { action_source: string } }).event.action_source,
    ).toBe("other");
  });

  it("evento de venda velha é pulado sem chamar a Meta", async () => {
    const { admin, updates } = fakeAdmin({
      claimed: [claimed(1, { event_time: new Date(Date.now() - 8 * 86_400_000).toISOString() })],
      creds: CREDS,
      sale: sale(),
    });
    const fetchFn = vi.fn();
    expect(
      await deliverDueEvents(admin, { fetchFn: fetchFn as unknown as typeof fetch }),
    ).toMatchObject({ skipped: 1 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(updates[0]?.patch.status).toBe("skipped");
  });
});
