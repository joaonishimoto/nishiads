import { describe, expect, it } from "vitest";
import { isThemeChoice, resolveTheme } from "@/lib/theme";

describe("tema", () => {
  it("automático segue o aparelho; claro e escuro valem como escolhidos", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("aceita só escolhas conhecidas vindas do armazenamento", () => {
    expect(isThemeChoice("system")).toBe(true);
    expect(isThemeChoice("escuro")).toBe(false);
    expect(isThemeChoice(null)).toBe(false);
  });
});
