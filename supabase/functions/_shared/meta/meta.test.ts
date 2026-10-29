import { describe, expect, it, vi } from "vitest";
import { classifyMetaError, GraphClient, GRAPH_API_VERSION, MetaApiError, parseUsage } from "./graph.ts";
import { accountStatusFromMeta, actionCount, dateChunks, insightsWindow, mapInsight, normalizeAccountId, toCents, todayIn } from "./mapping.ts";

describe("mapping", () => {
  it("converte valores da Meta para centavos", () => {
    expect(toCents("12.34")).toBe(1234);
    expect(toCents("0.005")).toBe(1);
    expect(toCents(undefined)).toBe(0);
    expect(toCents("abc")).toBe(0);
  });

  it("calcula hoje no fuso da conta", () => {
    const now = new Date("2026-10-26T02:00:00Z"); // 23h do dia 25 em São Paulo
    expect(todayIn("America/Sao_Paulo", now)).toBe("2026-10-25");
    expect(todayIn("Europe/Lisbon", now)).toBe("2026-10-26");
    expect(todayIn("Fuso/Invalido", now)).toBe("2026-10-25");
  });

  it("faz backfill de 30 dias na primeira vez e depois refaz 3 dias", () => {
    const now = new Date("2026-10-26T15:00:00Z");
    expect(insightsWindow({ timezone: "America/Sao_Paulo", backfilled_at: null }, now)).toEqual({
      since: "2026-09-27",
      until: "2026-10-26",
      backfill: true,
    });
    expect(insightsWindow({ timezone: "America/Sao_Paulo", backfilled_at: "2026-10-01T00:00:00Z" }, now)).toEqual({
      since: "2026-10-24",
      until: "2026-10-26",
      backfill: false,
    });
  });

  it("divide o período em janelas, da mais recente para a mais antiga", () => {
    expect(dateChunks("2026-09-27", "2026-10-26", 10)).toEqual([
      { since: "2026-10-17", until: "2026-10-26" },
      { since: "2026-10-07", until: "2026-10-16" },
      { since: "2026-09-27", until: "2026-10-06" },
    ]);
    expect(dateChunks("2026-10-24", "2026-10-26", 10)).toEqual([{ since: "2026-10-24", until: "2026-10-26" }]);
  });

  it("mapeia uma linha de insights", () => {
    expect(
      mapInsight(
        {
          date_start: "2026-10-25",
          ad_id: "1",
          adset_id: "2",
          campaign_id: "3",
          account_currency: "brl",
          spend: "150.5",
          impressions: "10000",
          reach: "8000",
          clicks: "300",
          inline_link_clicks: "200",
          ctr: "3.123456789",
          cpc: "0.501667",
          cpm: "15.05",
          actions: [
            { action_type: "link_click", value: "200" },
            { action_type: "offsite_conversion.fb_pixel_complete_registration", value: "4" },
            { action_type: "omni_complete_registration", value: "5" },
            { action_type: "offsite_conversion.fb_pixel_start_trial", value: "2" },
          ],
        },
        "USD",
      ),
    ).toEqual({
      date: "2026-10-25",
      currency: "BRL",
      spend_cents: 15050,
      impressions: 10000,
      reach: 8000,
      clicks: 300,
      link_clicks: 200,
      ctr: 3.123457,
      cpc_cents: 50,
      cpm_cents: 1505,
      registrations: 5,
      trials: 2,
      actions: {
        link_click: 200,
        "offsite_conversion.fb_pixel_complete_registration": 4,
        omni_complete_registration: 5,
        "offsite_conversion.fb_pixel_start_trial": 2,
      },
    });
  });

  it("conta cada evento uma vez e zera quando a Meta não manda actions", () => {
    expect(actionCount(undefined, ["complete_registration"])).toBe(0);
    expect(
      actionCount(
        [
          { action_type: "complete_registration", value: "3" },
          { action_type: "offsite_conversion.fb_pixel_complete_registration", value: "3" },
        ],
        ["omni_complete_registration", "complete_registration", "offsite_conversion.fb_pixel_complete_registration"],
      ),
    ).toBe(3);
  });

  it("normaliza id e status da conta", () => {
    expect(normalizeAccountId("act_123")).toBe("123");
    expect(accountStatusFromMeta(1)).toBe("active");
    expect(accountStatusFromMeta(2)).toBe("disabled");
    expect(accountStatusFromMeta(9)).toBe("active");
  });
});

describe("graph", () => {
  it("usa uma única versão da Graph API", () => {
    expect(GRAPH_API_VERSION).toMatch(/^v\d+\.0$/);
  });

  it("classifica erros da Meta", () => {
    expect(classifyMetaError(400, 190, 463)).toBe("token");
    expect(classifyMetaError(400, 100, 460)).toBe("token");
    expect(classifyMetaError(400, 17, null)).toBe("rate_limit");
    expect(classifyMetaError(400, 80004, null)).toBe("rate_limit");
    expect(classifyMetaError(500, 2, null)).toBe("transient");
    expect(classifyMetaError(403, 200, null)).toBe("permission");
    expect(classifyMetaError(400, 100, null)).toBe("other");
  });

  it("lê os headers de uso", () => {
    const headers = new Headers({
      "x-business-use-case-usage": JSON.stringify({
        "123": [{ type: "ads_insights", call_count: 40, total_cputime: 92, total_time: 10, estimated_time_to_regain_access: 5 }],
      }),
      "x-app-usage": JSON.stringify({ call_count: 12, total_time: 3, total_cputime: 4 }),
    });
    expect(parseUsage(headers)).toEqual({ maxPercent: 92, regainSeconds: 300 });
    expect(parseUsage(new Headers({ "x-ad-account-usage": "nao-json" }))).toEqual({ maxPercent: 0, regainSeconds: 0 });
  });

  function response(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  it("pagina, assina com appsecret_proof e repete em erro transitório", async () => {
    const calls: URL[] = [];
    const replies = [
      response(500, { error: { message: "tente de novo", code: 2 } }),
      response(200, { data: [{ id: "1" }], paging: { next: "https://graph.facebook.com/v25.0/act_1/ads?after=abc&limit=2" } }),
      response(200, { data: [{ id: "2" }] }),
    ];
    const fetchFn = vi.fn(async (url: URL | string) => {
      calls.push(new URL(String(url)));
      return replies.shift()!;
    });
    const sleep = vi.fn(async () => {});
    const client = new GraphClient({ accessToken: "tok", appSecret: "segredo", fetchFn: fetchFn as unknown as typeof fetch, sleep });
    const ids: string[] = [];
    for await (const page of client.paginate<{ id: string }>("act_1/ads", { fields: "id", limit: 2 })) {
      ids.push(...page.map((p) => p.id));
    }
    expect(ids).toEqual(["1", "2"]);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(calls[0]!.pathname).toBe(`/${GRAPH_API_VERSION}/act_1/ads`);
    expect(calls[0]!.searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[2]!.searchParams.get("after")).toBe("abc");
    expect(calls[2]!.searchParams.get("access_token")).toBe("tok");
  });

  it("não repete token expirado nem rate limit longo", async () => {
    const sleep = vi.fn(async () => {});
    const expired = new GraphClient({
      accessToken: "tok",
      fetchFn: (async () => response(400, { error: { message: "expirou", code: 190, error_subcode: 463 } })) as unknown as typeof fetch,
      sleep,
    });
    await expect(expired.get("me")).rejects.toMatchObject({ kind: "token" });

    const limited = new GraphClient({
      accessToken: "tok",
      fetchFn: (async () =>
        response(400, { error: { message: "limite", code: 80004 } }, {
          "x-business-use-case-usage": JSON.stringify({ "1": [{ call_count: 100, estimated_time_to_regain_access: 20 }] }),
        })) as unknown as typeof fetch,
      sleep,
    });
    const error = await limited.get("act_1/insights").catch((e) => e);
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).toMatchObject({ kind: "rate_limit", retryAfterSeconds: 1200 });
    expect(sleep).not.toHaveBeenCalled();
  });
});
