import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { alertHeadline, alertPushPayload, alertsSummaryPayload, type AlertRow } from "./messages.ts";

const writeMock = vi.hoisted(() => ({ setMetaObjectStatus: vi.fn() }));
const pushMock = vi.hoisted(() => ({ deliverPush: vi.fn() }));
vi.mock("../meta/write.ts", () => writeMock);
vi.mock("../notify/sale-notifications.ts", () => pushMock);
vi.mock("../notify/vapid.ts", () => ({
  vapidFromEnv: () => ({ publicKey: "pub", privateKey: "priv", subject: "mailto:a@b.c" }),
}));

const { approveAlert, evaluateWorkspaceAlerts } = await import("./run.ts");

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());

const WS = "11111111-1111-1111-1111-111111111111";

function alert(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id: "al1",
    workspace_id: WS,
    rule_id: "r1",
    rule_name: "Sem venda hoje",
    condition: "spend_without_sale",
    level: "ad",
    time_window: "today",
    action: "approve_pause",
    threshold_cents: 10000,
    min_roas: null,
    ad_account_id: "acc",
    object_id: "a1",
    object_external_id: "700",
    object_name: "Vídeo depoimento",
    currency: "BRL",
    spend_cents: 15000,
    sales: 0,
    revenue_cents: 0,
    roas: "0.0000",
    cpa_cents: null,
    status: "pending",
    auto_action: false,
    error: null,
    ...overrides,
  };
}

describe("mensagens dos alertas", () => {
  it("gasto sem venda pede aprovação com botão de pausar", () => {
    expect(alertPushPayload(alert())).toEqual({
      title: "🚨 Gastou R$ 150,00 sem venda",
      body: "Anúncio “Vídeo depoimento” · hoje\nToque para pausar ou ignorar.",
      url: `/w/${WS}/alertas?alerta=al1`,
      tag: "alert:al1",
      actions: [{ action: "pause", title: "Pausar" }],
    });
  });

  it("ROAS e CPA usam vírgula e a moeda do workspace", () => {
    const roas = alert({ condition: "roas_below", level: "adset", roas: "0.8125", min_roas: "1.50", status: "notified" });
    expect(alertHeadline(roas)).toBe("ROAS 0,81, abaixo da meta de 1,5");
    expect(alertPushPayload(roas).body).toBe("Conjunto “Vídeo depoimento” · hoje\nRegra “Sem venda hoje”.");
    expect(alertPushPayload(roas).actions).toBeUndefined();

    const cpa = alert({ condition: "cpa_above", level: "campaign", time_window: "last_7d", sales: 2, cpa_cents: 15050 });
    expect(alertHeadline(cpa)).toBe("CPA R$ 150,50, acima do máximo de R$ 100,00");
    expect(alertPushPayload(cpa).body.split("\n")[0]).toBe("Campanha “Vídeo depoimento” · últimos 7 dias");
    expect(alertHeadline({ ...cpa, sales: 0, cpa_cents: null })).toBe("Gastou R$ 150,00 sem venda (CPA máximo R$ 100,00)");
  });

  it("pausa automática e falha da pausa automática", () => {
    const paused = alertPushPayload(alert({ status: "paused", auto_action: true }));
    expect(paused.title).toBe("⏸️ Gastou R$ 150,00 sem venda");
    expect(paused.body).toContain("Pausado automaticamente pela regra “Sem venda hoje”.");
    const failed = alertPushPayload(alert({ status: "pending", auto_action: true, error: "Falta a permissão ads_management." }));
    expect(failed.body).toContain("Não consegui pausar: Falta a permissão ads_management.");
    expect(failed.actions).toHaveLength(1);
  });

  it("resume vários alertas num push só", () => {
    const list = [1, 2, 3, 4, 5].map((i) =>
      alert({ id: `al${i}`, object_name: `Anúncio ${i}`, status: i === 1 ? "paused" : "pending" }),
    );
    const summary = alertsSummaryPayload(WS, list, 42);
    expect(summary.title).toBe("🔔 5 alertas novos (1 pausado, 4 esperando aprovação)");
    expect(summary.body.split("\n")).toEqual([
      "• Anúncio 1: Gastou R$ 150,00 sem venda",
      "• Anúncio 2: Gastou R$ 150,00 sem venda",
      "• Anúncio 3: Gastou R$ 150,00 sem venda",
      "e mais 2",
    ]);
    expect(summary.url).toBe(`/w/${WS}/alertas`);
    expect(summary.tag).toBe(`alerts:${WS}:42`);
  });
});

type Row = Record<string, unknown>;

/** Supabase em memória: o que run.ts usa (select/update com eq/in, maybeSingle, rpc). */
function fakeAdmin(tables: Record<string, Row[]>, rpcs: Record<string, unknown>) {
  const updates: { table: string; values: Row }[] = [];
  const from = (table: string) => {
    const filters: [string, string, unknown][] = [];
    let values: Row | null = null;
    const run = () => {
      const rows = (tables[table] ??= []).filter((r) =>
        filters.every(([kind, col, v]) => (kind === "eq" ? r[col] === v : (v as unknown[]).includes(r[col]))),
      );
      if (values) {
        updates.push({ table, values });
        rows.forEach((r) => Object.assign(r, values));
      }
      return rows.map((r) => ({ ...r }));
    };
    const builder = {
      select: () => builder,
      update: (v: Row) => ((values = v), builder),
      eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), builder),
      in: (c: string, v: unknown[]) => (filters.push(["in", c, v]), builder),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: run(), error: null }),
    };
    return builder;
  };
  const admin = {
    from,
    rpc: async (name: string) => ({ data: rpcs[name] ?? null, error: null }),
  } as unknown as SupabaseClient;
  return { admin, updates, tables };
}

const recipient = { subscription_id: "s1", user_id: "u1", endpoint: "https://push", config: {}, sound_enabled: true };

describe("avaliação das regras", () => {
  beforeEach(() => {
    writeMock.setMetaObjectStatus.mockReset();
    pushMock.deliverPush.mockReset().mockResolvedValue(1);
  });

  it("pausa o que a regra reservou, avisa e conta o resultado", async () => {
    const created = [
      alert({ id: "al1", status: "pausing", auto_action: true, action: "auto_pause" }),
      alert({ id: "al2", object_id: "a2", status: "notified", action: "notify" }),
    ];
    const { admin, tables } = fakeAdmin(
      { alerts: created.map((a) => ({ ...a })) },
      { service_evaluate_alert_rules: created, service_notification_recipients: [recipient] },
    );
    writeMock.setMetaObjectStatus.mockResolvedValue({ ok: true, object: {} });

    const result = await evaluateWorkspaceAlerts(admin, WS);
    expect(result).toEqual({ created: 2, paused: 1, pending: 0, delivered: 2 });
    expect(writeMock.setMetaObjectStatus).toHaveBeenCalledTimes(1);
    expect(writeMock.setMetaObjectStatus.mock.calls[0]![1]).toMatchObject({
      workspaceId: WS,
      level: "ad",
      objectId: "a1",
      status: "PAUSED",
      actorUserId: null,
      source: "rule",
      context: { rule_id: "r1", alert_id: "al1", reason: "spend_without_sale", approved: false },
    });
    expect(tables.alerts!.find((a) => a.id === "al1")).toMatchObject({ status: "paused", push_delivered: 1 });
    expect(pushMock.deliverPush.mock.calls[0]![2].title).toBe("⏸️ Gastou R$ 150,00 sem venda");
  });

  it("se a Meta recusar a pausa automática, vira pedido de aprovação com o motivo", async () => {
    const created = [alert({ status: "pausing", auto_action: true, action: "auto_pause" })];
    const { admin, tables } = fakeAdmin(
      { alerts: created.map((a) => ({ ...a })) },
      { service_evaluate_alert_rules: created, service_notification_recipients: [recipient] },
    );
    writeMock.setMetaObjectStatus.mockResolvedValue({ ok: false, kind: "missing_permission", error: "Falta a permissão." });

    const result = await evaluateWorkspaceAlerts(admin, WS);
    expect(result).toMatchObject({ paused: 0, pending: 1 });
    expect(tables.alerts![0]).toMatchObject({ status: "pending", error: "Falta a permissão." });
    expect(pushMock.deliverPush.mock.calls[0]![2].body).toContain("Não consegui pausar: Falta a permissão.");
  });

  it("perto do limite de tempo não chama a Meta e pede aprovação", async () => {
    const created = [alert({ status: "pausing", auto_action: true, action: "auto_pause" })];
    const { admin, tables } = fakeAdmin(
      { alerts: created.map((a) => ({ ...a })) },
      { service_evaluate_alert_rules: created, service_notification_recipients: [recipient] },
    );
    await evaluateWorkspaceAlerts(admin, WS, { deadline: Date.now() });
    expect(writeMock.setMetaObjectStatus).not.toHaveBeenCalled();
    expect(tables.alerts![0]!.status).toBe("pending");
  });

  it("muitos alertas viram um push de resumo", async () => {
    const created = [1, 2, 3, 4].map((i) => alert({ id: `al${i}`, status: "notified" }));
    const { admin } = fakeAdmin(
      { alerts: created.map((a) => ({ ...a })) },
      { service_evaluate_alert_rules: created, service_notification_recipients: [recipient] },
    );
    await evaluateWorkspaceAlerts(admin, WS);
    expect(pushMock.deliverPush).toHaveBeenCalledTimes(1);
    expect(pushMock.deliverPush.mock.calls[0]![2].title).toBe("🔔 4 alertas novos");
  });

  it("sem alertas novos não manda nada", async () => {
    const { admin } = fakeAdmin({}, { service_evaluate_alert_rules: [] });
    expect(await evaluateWorkspaceAlerts(admin, WS)).toEqual({ created: 0, paused: 0, pending: 0, delivered: 0 });
    expect(pushMock.deliverPush).not.toHaveBeenCalled();
  });
});

describe("aprovação com um toque", () => {
  beforeEach(() => {
    writeMock.setMetaObjectStatus.mockReset();
  });

  const world = (role: string | null, status: AlertRow["status"] = "pending") =>
    fakeAdmin(
      {
        alerts: [{ ...alert({ status }), created_at: new Date().toISOString() }],
        workspace_members: role ? [{ workspace_id: WS, user_id: "u1", role }] : [],
      },
      {},
    );

  it("owner pausa; o alerta fica resolvido por ele", async () => {
    const { admin, tables } = world("owner");
    writeMock.setMetaObjectStatus.mockResolvedValue({ ok: true, object: {} });
    expect(await approveAlert(admin, "al1", "u1")).toEqual({ ok: true, status: "paused" });
    expect(writeMock.setMetaObjectStatus.mock.calls[0]![1]).toMatchObject({ actorUserId: "u1", source: "rule" });
    expect(tables.alerts![0]).toMatchObject({ status: "paused", resolved_by: "u1" });
  });

  it("viewer não pausa e quem não é membro nem vê o alerta", async () => {
    expect(await approveAlert(world("viewer").admin, "al1", "u1")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await approveAlert(world(null).admin, "al1", "u1")).toMatchObject({ ok: false, code: "not_found" });
    expect(writeMock.setMetaObjectStatus).not.toHaveBeenCalled();
  });

  it("segundo toque não pausa de novo", async () => {
    expect(await approveAlert(world("admin", "paused").admin, "al1", "u1")).toEqual({ ok: true, status: "paused" });
    expect(await approveAlert(world("admin", "dismissed").admin, "al1", "u1")).toMatchObject({ code: "resolved" });
    expect(writeMock.setMetaObjectStatus).not.toHaveBeenCalled();
  });

  it("pedido com mais de 24 horas expira em vez de pausar", async () => {
    const { admin, tables } = world("owner");
    tables.alerts![0]!.created_at = new Date(Date.now() - 25 * 3600_000).toISOString();
    expect(await approveAlert(admin, "al1", "u1")).toMatchObject({ ok: false, code: "resolved" });
    expect(tables.alerts![0]!.status).toBe("expired");
    expect(writeMock.setMetaObjectStatus).not.toHaveBeenCalled();
  });

  it("falha da Meta devolve o motivo e deixa tentar de novo", async () => {
    const { admin, tables } = world("admin");
    writeMock.setMetaObjectStatus.mockRejectedValue(new Error("rede caiu"));
    expect(await approveAlert(admin, "al1", "u1")).toMatchObject({ ok: false, code: "pause_failed" });
    expect(tables.alerts![0]).toMatchObject({ status: "pending" });
    expect(String(tables.alerts![0]!.error)).toContain("rede caiu");
  });
});
