import { describe, expect, it } from "vitest";
import {
  DEFAULT_BODY,
  DEFAULT_TITLE,
  renderSummary,
  renderTemplate,
  unknownVariables,
  type DailySummaryNumbers,
} from "./template.ts";

const numbers: DailySummaryNumbers = {
  workspace: "Drinfy",
  currency: "BRL",
  timezone: "America/Sao_Paulo",
  day: "2026-11-05",
  spend_cents: 25_000,
  link_clicks: 1234,
  impressions: 45_678,
  registrations: 42,
  trials: 7,
  open_trials: 5,
  trial_value_cents: 33_500,
  sales: 2,
  revenue_cents: 13_400,
  earnings_cents: 46_900,
  roas: "0.5360",
  trial_roas: "1.8760",
  cpa_cents: 12_500,
  cost_per_registration_cents: 595,
  cost_per_trial_cents: 3571,
};

describe("resumo diário: modelo", () => {
  it("monta o texto padrão com os números do dia", () => {
    const out = renderSummary({ title: DEFAULT_TITLE, body: DEFAULT_BODY }, numbers);
    expect(out.title).toBe("📊 Resumo de 05/11");
    expect(out.body).toBe(
      "Cadastros: 42\nTestes: 7\nVendas: 2 · R$ 134,00\nGasto: R$ 250,00 · ROAS 0,54x",
    );
  });

  it("aceita qualquer variável da lista e mantém as desconhecidas", () => {
    expect(
      renderTemplate(
        "{dia_semana} {roas_testes} {ganhos} {custo_cadastro} {cliques} {foo}",
        numbers,
      ),
    ).toBe("quinta 1,88x R$ 469,00 R$ 5,95 1.234 {foo}");
    expect(unknownVariables("{cadastros} {foo} {foo} {bar}")).toEqual(["{foo}", "{bar}"]);
  });

  it("sem gasto, ROAS e custos viram traço", () => {
    const out = renderTemplate("{roas} {cpa} {custo_teste}", {
      ...numbers,
      spend_cents: 0,
      roas: null,
      cpa_cents: null,
      cost_per_trial_cents: null,
    });
    expect(out).toBe("— — —");
  });
});
