import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { budgetToCents, centsToBudget } from "./mapping.ts";
import { setMetaBudget, setMetaObjectStatus } from "./write.ts";

// write.ts lê META_APP_SECRET e o envio de push lê as chaves VAPID pelo Deno.env.
beforeAll(() => {
  (globalThis as { Deno?: unknown }).Deno = { env: { get: () => undefined } };
});
afterAll(() => {
  delete (globalThis as { Deno?: unknown }).Deno;
});

type Row = Record<string, unknown>;

/** Supabase em memória: só o que write.ts usa (select/update/insert com eq/in, rpc). */
function fakeAdmin(tables: Record<string, Row[]>) {
  const inserts: { table: string; values: Row }[] = [];
  const updates: { table: string; values: Row; filters: [string, string, unknown][] }[] = [];
  const from = (table: string) => {
    const filters: [string, string, unknown][] = [];
    let op: "select" | "update" = "select";
    let values: Row = {};
    const matches = (r: Row) =>
      filters.every(([kind, col, v]) =>
        kind === "eq" ? r[col] === v : kind === "in" ? (v as unknown[]).includes(r[col]) : true,
      );
    const run = () => {
      const rows = (tables[table] ??= []).filter(matches);
      if (op === "update") {
        updates.push({ table, values, filters: [...filters] });
        rows.forEach((r) => Object.assign(r, values));
      }
      return rows;
    };
    const builder = {
      select: () => builder,
      update: (v: Row) => ((op = "update"), (values = v), builder),
      insert: async (v: Row) => (inserts.push({ table, values: v }), { error: null }),
      eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), builder),
      in: (c: string, v: unknown[]) => (filters.push(["in", c, v]), builder),
      gte: () => builder,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: run(), error: null }),
    };
    return builder;
  };
  const admin = {
    from,
    rpc: async (name: string) => (name === "service_read_secret" ? { data: "tok", error: null } : { data: null, error: null }),
  } as unknown as SupabaseClient;
  return { admin, inserts, updates, tables };
}

const WS = "11111111-1111-1111-1111-111111111111";

function world(overrides: { scopes?: string[]; currency?: string } = {}) {
  return fakeAdmin({
    ad_accounts: [{ id: "acc", currency: overrides.currency ?? "BRL", status: "active", meta_connection_id: "conn" }],
    meta_connections: [{
      id: "conn",
      workspace_id: WS,
      status: "active",
      token_ref: "secret",
      scopes: overrides.scopes ?? ["ads_read", "ads_management"],
      meta_user_name: "João",
    }],
    campaigns: [{
      id: "c1", workspace_id: WS, ad_account_id: "acc", external_id: "900", name: "Campanha", status: "ACTIVE",
      effective_status: "ACTIVE", daily_budget_cents: 5000, lifetime_budget_cents: null,
    }],
    adsets: [{
      id: "s1", workspace_id: WS, ad_account_id: "acc", external_id: "800", name: "Conjunto", status: "ACTIVE",
      effective_status: "ACTIVE", daily_budget_cents: null, lifetime_budget_cents: null,
    }],
    ads: [{
      id: "a1", workspace_id: WS, ad_account_id: "acc", external_id: "700", name: "Anúncio", status: "ACTIVE",
      effective_status: "ACTIVE",
    }],
    workspace_members: [],
  });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { method: string; path: string; params: URLSearchParams };

/** Graph API falsa: `routes` responde por "METHOD path". */
function graph(routes: Record<string, (params: URLSearchParams) => Response>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const params = method === "POST" ? new URLSearchParams(String(init?.body ?? "")) : url.searchParams;
    const path = url.pathname.replace(/^\/v[\d.]+\//, "");
    calls.push({ method, path, params });
    const route = routes[`${method} ${path}`];
    if (!route) return json(404, { error: { message: `sem rota ${method} ${path}`, code: 100 } });
    return route(params);
  });
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

const base = { workspaceId: WS, actorUserId: "u1", source: "manual" as const };

describe("orçamento ↔ centavos", () => {
  it("respeita o offset da moeda", () => {
    expect(budgetToCents("5000", "BRL")).toBe(5000);
    expect(budgetToCents("5000", "JPY")).toBe(500000);
    expect(budgetToCents("0", "BRL")).toBeNull();
    expect(budgetToCents(undefined, "BRL")).toBeNull();
    expect(centsToBudget(12345, "BRL")).toBe(12345);
    expect(centsToBudget(500000, "JPY")).toBe(5000);
  });
});

describe("setMetaObjectStatus", () => {
  it("pausa a campanha, relê o objeto e os filhos e registra no histórico", async () => {
    const db = world();
    const meta = graph({
      "POST 900": () => json(200, { success: true }),
      "GET 900": () => json(200, { id: "900", status: "PAUSED", effective_status: "PAUSED", daily_budget: "5000" }),
      "GET 900/adsets": () => json(200, { data: [{ id: "800", status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED" }] }),
      "GET 900/ads": () => json(200, { data: [{ id: "700", status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED" }] }),
    });
    const result = await setMetaObjectStatus(
      db.admin,
      { ...base, level: "campaign", objectId: "c1", status: "PAUSED", context: { rule_id: "r1" } },
      { appSecret: "segredo", fetchFn: meta.fetchFn },
    );

    expect(result).toEqual({
      ok: true,
      object: { status: "PAUSED", effective_status: "PAUSED", daily_budget_cents: 5000, lifetime_budget_cents: null },
    });
    const post = meta.calls.find((c) => c.method === "POST")!;
    expect(post.params.get("status")).toBe("PAUSED");
    expect(post.params.get("access_token")).toBe("tok");
    expect(post.params.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
    expect(db.tables.campaigns![0]).toMatchObject({ status: "PAUSED", effective_status: "PAUSED" });
    expect(db.tables.adsets![0]).toMatchObject({ effective_status: "CAMPAIGN_PAUSED" });
    expect(db.tables.ads![0]).toMatchObject({ effective_status: "CAMPAIGN_PAUSED" });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({
      table: "meta_action_log",
      values: {
        action: "pause", ok: true, level: "campaign", object_id: "c1", external_id: "900", actor_user_id: "u1",
        previous: { status: "ACTIVE", effective_status: "ACTIVE" }, requested: { status: "PAUSED" },
        context: { rule_id: "r1" }, source: "manual",
      },
    });
  });

  it("sem ads_management não chama a Meta e registra a recusa", async () => {
    const db = world({ scopes: ["ads_read"] });
    const meta = graph({});
    const result = await setMetaObjectStatus(
      db.admin,
      { ...base, level: "ad", objectId: "a1", status: "PAUSED" },
      { fetchFn: meta.fetchFn },
    );
    expect(result).toMatchObject({ ok: false, kind: "missing_permission" });
    expect(meta.calls).toHaveLength(0);
    expect(db.inserts[0]!.values).toMatchObject({ ok: false, action: "pause" });
  });

  it("objeto de outro workspace não é encontrado", async () => {
    const db = world();
    const meta = graph({});
    const result = await setMetaObjectStatus(
      db.admin,
      { ...base, workspaceId: "22222222-2222-2222-2222-222222222222", level: "ad", objectId: "a1", status: "ACTIVE" },
      { fetchFn: meta.fetchFn },
    );
    expect(result).toMatchObject({ ok: false, kind: "not_found" });
    expect(meta.calls).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it("token expirado marca a conexão para reconectar", async () => {
    const db = world();
    const meta = graph({ "POST 700": () => json(400, { error: { message: "expirou", code: 190, error_subcode: 463 } }) });
    const result = await setMetaObjectStatus(
      db.admin,
      { ...base, level: "ad", objectId: "a1", status: "ACTIVE" },
      { fetchFn: meta.fetchFn },
    );
    expect(result).toMatchObject({ ok: false, kind: "needs_reconnect" });
    expect(db.tables.meta_connections![0]).toMatchObject({ status: "needs_reconnect" });
    expect(db.tables.ad_accounts![0]).toMatchObject({ status: "needs_reconnect" });
    expect(db.inserts[0]!.values).toMatchObject({ ok: false, action: "activate" });
  });

  it("devolve a mensagem da Meta para o usuário quando ela recusa", async () => {
    const db = world();
    const meta = graph({
      "POST 700": () =>
        json(400, { error: { message: "(#200) Permissions error", code: 200, error_user_msg: "Você não pode editar esta conta." } }),
    });
    const result = await setMetaObjectStatus(
      db.admin,
      { ...base, level: "ad", objectId: "a1", status: "PAUSED" },
      { fetchFn: meta.fetchFn },
    );
    expect(result).toEqual({ ok: false, kind: "missing_permission", error: "Você não pode editar esta conta." });
    expect(db.tables.ads![0]).toMatchObject({ status: "ACTIVE" });
  });

  it("se só a releitura falhar, a ação conta como feita", async () => {
    const db = world();
    const meta = graph({
      "POST 700": () => json(200, { success: true }),
      "GET 700": () => json(400, { error: { message: "estranho", code: 100 } }),
    });
    const result = await setMetaObjectStatus(
      db.admin,
      { ...base, level: "ad", objectId: "a1", status: "PAUSED" },
      { fetchFn: meta.fetchFn },
    );
    expect(result).toMatchObject({ ok: true, object: { status: "PAUSED" } });
    expect(db.inserts[0]!.values).toMatchObject({ ok: true });
  });
});

describe("setMetaBudget", () => {
  it("muda o orçamento diário da campanha (CBO)", async () => {
    const db = world();
    const meta = graph({
      "GET 900": (p) =>
        p.get("fields")!.includes("status")
          ? json(200, { id: "900", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "7500" })
          : json(200, { daily_budget: "5000" }),
      "POST 900": () => json(200, { success: true }),
      "GET 900/adsets": () => json(200, { data: [] }),
      "GET 900/ads": () => json(200, { data: [] }),
    });
    const result = await setMetaBudget(
      db.admin,
      { ...base, level: "campaign", objectId: "c1", budgetCents: 7500 },
      { fetchFn: meta.fetchFn },
    );
    expect(result).toMatchObject({ ok: true, object: { daily_budget_cents: 7500 } });
    const post = meta.calls.find((c) => c.method === "POST")!;
    expect(post.params.get("daily_budget")).toBe("7500");
    expect(post.params.has("lifetime_budget")).toBe(false);
    expect(db.tables.campaigns![0]).toMatchObject({ daily_budget_cents: 7500 });
    expect(db.inserts[0]!.values).toMatchObject({
      action: "set_budget", ok: true, previous: { daily_budget_cents: 5000 }, requested: { daily_budget_cents: 7500 },
    });
  });

  it("usa o orçamento total quando é o que o conjunto tem, na menor unidade da moeda", async () => {
    const db = world({ currency: "JPY" });
    const meta = graph({
      "GET 800": (p) =>
        p.get("fields")!.includes("status")
          ? json(200, { id: "800", status: "ACTIVE", effective_status: "ACTIVE", lifetime_budget: "3000" })
          : json(200, { lifetime_budget: "2000", campaign: {} }),
      "POST 800": () => json(200, { success: true }),
      "GET 800/ads": () => json(200, { data: [] }),
    });
    const result = await setMetaBudget(
      db.admin,
      { ...base, level: "adset", objectId: "s1", budgetCents: 300000 },
      { fetchFn: meta.fetchFn },
    );
    expect(result).toMatchObject({ ok: true, object: { lifetime_budget_cents: 300000, daily_budget_cents: null } });
    expect(meta.calls.find((c) => c.method === "POST")!.params.get("lifetime_budget")).toBe("3000");
  });

  it("recusa o conjunto de uma campanha com orçamento de campanha", async () => {
    const db = world();
    const meta = graph({ "GET 800": () => json(200, { campaign: { daily_budget: "5000" } }) });
    const result = await setMetaBudget(
      db.admin,
      { ...base, level: "adset", objectId: "s1", budgetCents: 9000 },
      { fetchFn: meta.fetchFn },
    );
    expect(result).toMatchObject({ ok: false, kind: "invalid", error: expect.stringContaining("CBO") });
    expect(meta.calls.some((c) => c.method === "POST")).toBe(false);
    expect(db.inserts[0]!.values).toMatchObject({ ok: false, action: "set_budget" });
  });

  it("valida o valor antes de qualquer chamada", async () => {
    const db = world();
    const meta = graph({});
    for (const budgetCents of [0, 50, 1.5, 200_000_000]) {
      const result = await setMetaBudget(
        db.admin,
        { ...base, level: "campaign", objectId: "c1", budgetCents },
        { fetchFn: meta.fetchFn },
      );
      expect(result).toMatchObject({ ok: false, kind: "invalid" });
    }
    expect(meta.calls).toHaveLength(0);
  });
});

describe("erros inesperados", () => {
  it("falha do banco vira resultado, sem lançar", async () => {
    const db = world();
    const broken = {
      ...db.admin,
      from: () => {
        throw new Error("conexão caiu");
      },
    } as unknown as SupabaseClient;
    const result = await setMetaObjectStatus(
      broken,
      { ...base, level: "ad", objectId: "a1", status: "PAUSED" },
      { fetchFn: graph({}).fetchFn },
    );
    expect(result).toMatchObject({ ok: false, kind: "internal" });
  });
});
