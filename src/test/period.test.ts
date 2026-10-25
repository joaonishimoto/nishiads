import { describe, expect, it } from "vitest";
import { addDays, periodRange, startOfDayInZone, ymdInZone } from "@/lib/period";
import { splitUtmRef } from "@/lib/utm";

describe("períodos no fuso do workspace", () => {
  // 25/10/2026 01:30 UTC = 24/10/2026 22:30 em São Paulo.
  const now = new Date("2026-10-25T01:30:00Z");

  it("usa o dia local, não o dia UTC", () => {
    expect(ymdInZone(now, "America/Sao_Paulo")).toBe("2026-10-24");
    expect(periodRange("today", "America/Sao_Paulo", now)).toEqual({
      from: "2026-10-24T03:00:00.000Z",
      to: "2026-10-25T03:00:00.000Z",
    });
  });

  it("ontem, 7 e 30 dias", () => {
    expect(periodRange("yesterday", "America/Sao_Paulo", now).from).toBe("2026-10-23T03:00:00.000Z");
    expect(periodRange("7d", "America/Sao_Paulo", now).from).toBe("2026-10-18T03:00:00.000Z");
    expect(periodRange("30d", "America/Sao_Paulo", now).from).toBe("2026-09-25T03:00:00.000Z");
  });

  it("período personalizado inclui o último dia", () => {
    expect(periodRange("custom", "America/Sao_Paulo", now, { from: "2026-10-01", to: "2026-10-03" })).toEqual({
      from: "2026-10-01T03:00:00.000Z",
      to: "2026-10-04T03:00:00.000Z",
    });
  });

  it("lida com fusos com horário de verão", () => {
    expect(startOfDayInZone("2026-07-01", "Europe/Lisbon").toISOString()).toBe("2026-06-30T23:00:00.000Z");
    expect(startOfDayInZone("2026-01-15", "Europe/Lisbon").toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("UTMs", () => {
  it("separa nome e id como o banco", () => {
    expect(splitUtmRef("Black Friday | Topo|1202000001")).toEqual({ name: "Black Friday | Topo", id: "1202000001" });
    expect(splitUtmRef("1202000001")).toEqual({ name: null, id: "1202000001" });
    expect(splitUtmRef("Só nome")).toEqual({ name: "Só nome", id: null });
    expect(splitUtmRef(null)).toEqual({ name: null, id: null });
  });
});
