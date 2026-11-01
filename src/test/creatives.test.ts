import { describe, expect, it } from "vitest";
import type { NodeMetrics } from "@/features/results/metrics";
import {
  averageCpa,
  creative,
  registrationsOf,
  verdictOf,
} from "@/features/results/creative-insights";

const m = (over: Partial<NodeMetrics> = {}): NodeMetrics => ({
  spendCents: 0,
  impressions: 0,
  linkClicks: 0,
  allClicks: 0,
  registrations: 0,
  trials: 0,
  actions: {},
  tracked: {},
  sales: 0,
  revenueCents: 0,
  feesCents: 0,
  costCents: 0,
  ...over,
});

describe("criativos", () => {
  it("prefere os cadastros do rastreamento próprio aos da Meta", () => {
    expect(registrationsOf(m({ registrations: 4, tracked: { cadastro: 6 } }))).toEqual({
      count: 6,
      source: "rastreio",
    });
    expect(registrationsOf(m({ registrations: 4 }))).toEqual({ count: 4, source: "meta" });
    expect(registrationsOf(m())).toEqual({ count: 0, source: null });
  });

  it("dá o veredito pelo ROAS e, sem venda, pelo CPA médio", () => {
    expect(verdictOf(m(), 2, 5000)).toBe("idle");
    expect(verdictOf(m({ spendCents: 1000, revenueCents: 3000, sales: 1 }), 2, 5000)).toBe("scale");
    expect(verdictOf(m({ spendCents: 1000, revenueCents: 1500, sales: 1 }), 2, 5000)).toBe("watch");
    expect(verdictOf(m({ spendCents: 1000, revenueCents: 500, sales: 1 }), 2, 5000)).toBe("loss");
    expect(verdictOf(m({ spendCents: 6000 }), 2, 5000)).toBe("pause");
    expect(verdictOf(m({ spendCents: 1000 }), 2, 5000)).toBe("learning");
    expect(verdictOf(m({ spendCents: 9000 }), 2, null)).toBe("learning");
  });

  it("calcula CPA médio, custo por cadastro e retenção de 3 s", () => {
    expect(averageCpa([m({ spendCents: 3000, sales: 1 }), m({ spendCents: 1000, sales: 1 })])).toBe(
      2000,
    );
    expect(averageCpa([m({ spendCents: 3000 })])).toBeNull();
    expect(creative.costPerRegistration(m({ spendCents: 1000, tracked: { cadastro: 4 } }))).toBe(
      250,
    );
    expect(creative.hookRate(m({ impressions: 1000, actions: { video_view: 300 } }))).toBe(0.3);
    expect(creative.cpm(m({ spendCents: 500, impressions: 1000 }))).toBe(500);
  });
});
