import { describe, expect, it } from "vitest";
import {
  alertHeadline,
  alertWindowText,
  canPause,
  describeRule,
  EMPTY_DRAFT,
  parseRoas,
  RULE_PRESETS,
  ruleToDraft,
  validateRule,
  type Alert,
  type AlertRule,
} from "@/features/alerts/rules";

describe("regras de alerta: formulário", () => {
  it("converte reais em centavos e limpa o que não vale para a condição", () => {
    const { values, errors } = validateRule({ ...EMPTY_DRAFT, name: "  Sem venda  ", threshold: 100, min_spend: 30 });
    expect(errors).toEqual({});
    expect(values).toMatchObject({
      name: "Sem venda",
      condition: "spend_without_sale",
      threshold_cents: 10000,
      min_roas: null,
      // Gastou sem vender já tem o próprio valor de gasto.
      min_spend_cents: 0,
      max_auto_pauses_per_day: 3,
    });
  });

  it("ROAS aceita vírgula e não guarda valor em dinheiro", () => {
    const { values } = validateRule({ ...EMPTY_DRAFT, name: "ROAS", condition: "roas_below", min_roas: "1,5", min_spend: 50 });
    expect(values).toMatchObject({ min_roas: 1.5, threshold_cents: null, min_spend_cents: 5000 });
    expect(parseRoas("2.25")).toBe(2.25);
    expect(parseRoas("0")).toBeNull();
    expect(parseRoas("abc")).toBeNull();
    expect(parseRoas("101")).toBeNull();
  });

  it("aponta o que falta", () => {
    expect(validateRule({ ...EMPTY_DRAFT, name: "", threshold: 0 }).errors).toMatchObject({
      name: expect.any(String),
      threshold: "Informe quanto pode gastar sem vender.",
    });
    expect(validateRule({ ...EMPTY_DRAFT, name: "x", condition: "cpa_above", threshold: 0 }).errors.threshold).toBe(
      "Informe o CPA máximo.",
    );
    expect(validateRule({ ...EMPTY_DRAFT, name: "x", condition: "roas_below", min_roas: "" }).errors.min_roas).toBeDefined();
    expect(
      validateRule({ ...EMPTY_DRAFT, name: "x", action: "auto_pause", max_auto_pauses_per_day: 0 }).errors
        .max_auto_pauses_per_day,
    ).toBe("Entre 1 e 50.");
  });

  it("os modelos já são regras válidas", () => {
    for (const preset of RULE_PRESETS) expect(validateRule(preset.draft).values).toBeDefined();
  });

  it("ida e volta pelo banco mantém os valores", () => {
    const { values } = validateRule({ ...EMPTY_DRAFT, name: "CPA", condition: "cpa_above", threshold: 80.5, min_spend: 20 });
    const rule = { ...values!, id: "r1", workspace_id: "w", created_by: null, last_evaluated_at: null, created_at: "", updated_at: "" } as AlertRule;
    expect(validateRule(ruleToDraft(rule)).values).toEqual(values);
  });
});

/** Intl separa "R$" do valor com espaço não separável. */
const plain = (text: string) => text.replace(/\u00a0/g, " ");

describe("regras de alerta: textos", () => {
  const base = { level: "ad", time_window: "today", threshold_cents: 10000, min_roas: null, min_spend_cents: 0 } as const;

  it("descreve cada condição", () => {
    expect(plain(describeRule({ ...base, condition: "spend_without_sale" }, "BRL"))).toBe(
      "Anúncios que gastaram R$ 100,00 sem venda hoje",
    );
    expect(
      plain(
        describeRule({ ...base, condition: "roas_below", level: "adset", threshold_cents: null, min_roas: 1.5, min_spend_cents: 5000 }, "BRL"),
      ),
    ).toBe("Conjuntos com ROAS abaixo de 1,5 hoje, depois de gastar R$ 50,00");
    expect(plain(describeRule({ ...base, condition: "cpa_above", level: "campaign", time_window: "last_7d" }, "BRL"))).toBe(
      "Campanhas com CPA acima de R$ 100,00 nos últimos 7 dias",
    );
  });

  it("título do alerta e quando dá para pausar", () => {
    const alert = {
      condition: "cpa_above",
      currency: "BRL",
      spend_cents: 30000,
      sales: 2,
      cpa_cents: 15000,
      threshold_cents: 10000,
      roas: 0.5,
      min_roas: null,
      status: "pending",
      created_at: new Date().toISOString(),
    } as Alert;
    expect(plain(alertHeadline(alert))).toBe("CPA R$ 150,00, acima do máximo de R$ 100,00");
    expect(plain(alertHeadline({ ...alert, sales: 0, cpa_cents: null }))).toBe("Gastou R$ 300,00 sem venda (CPA máximo R$ 100,00)");
    expect(plain(alertHeadline({ ...alert, condition: "roas_below", roas: 0.8125, min_roas: 2 }))).toBe(
      "ROAS 0,81, abaixo da meta de 2,0",
    );
    expect(canPause(alert)).toBe(true);
    const now = new Date().toISOString();
    expect(canPause({ status: "notified", created_at: now })).toBe(true);
    expect(canPause({ status: "paused", created_at: now })).toBe(false);
    expect(canPause({ status: "expired", created_at: now })).toBe(false);
    expect(canPause({ status: "pending", created_at: new Date(Date.now() - 25 * 3600_000).toISOString() })).toBe(false);
  });

  it("período relativo ao dia do alerta", () => {
    expect(alertWindowText({ time_window: "today", period_key: "2026-10-26" }, "2026-10-26")).toBe("hoje");
    expect(alertWindowText({ time_window: "today", period_key: "2026-10-24" }, "2026-10-26")).toBe("em 24/10");
    expect(alertWindowText({ time_window: "last_3d", period_key: "2026-10-26" }, "2026-10-26")).toBe("nos últimos 3 dias");
    expect(alertWindowText({ time_window: "last_7d", period_key: "2026-10-20" }, "2026-10-26")).toBe("nos 7 dias até 20/10");
  });
});
