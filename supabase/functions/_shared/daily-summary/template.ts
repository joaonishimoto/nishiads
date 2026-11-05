/**
 * Resumo diário: variáveis do modelo e montagem do texto. Sem imports, para servir à
 * Edge Function (Deno) e à prévia no app (Vite) com o mesmo código.
 */

/** O que service_daily_summary_numbers devolve (jsonb). Numéricos podem vir como texto. */
export type DailySummaryNumbers = {
  workspace: string;
  currency: string;
  timezone: string;
  day: string;
  spend_cents: number;
  link_clicks: number;
  impressions: number;
  registrations: number;
  trials: number;
  open_trials: number;
  trial_value_cents: number;
  sales: number;
  revenue_cents: number;
  earnings_cents: number;
  roas: number | string | null;
  trial_roas: number | string | null;
  cpa_cents: number | string | null;
  cost_per_registration_cents: number | string | null;
  cost_per_trial_cents: number | string | null;
};

export type SummaryVariable = {
  key: string;
  label: string;
  value: (n: DailySummaryNumbers) => string;
};

const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);

function money(cents: number | string | null, currency: string): string {
  const v = num(cents);
  if (v === null) return "—";
  // Intl separa "R$" do valor com espaço não separável; na notificação, espaço comum.
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency })
    .format(v / 100)
    .replace(/ /g, " ");
}

const int = (v: number | string | null) => new Intl.NumberFormat("pt-BR").format(num(v) ?? 0);

function roas(v: number | string | null): string {
  const n = num(v);
  if (n === null) return "—";
  return `${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x`;
}

/** "05/11" a partir de "2026-11-05". */
function shortDate(day: string): string {
  const [, m, d] = day.split("-");
  return `${d}/${m}`;
}

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
function weekday(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay()] ?? "";
}

/** Variáveis aceitas no modelo, na ordem em que aparecem no editor. */
export const SUMMARY_VARIABLES: SummaryVariable[] = [
  { key: "cadastros", label: "Cadastros", value: (n) => int(n.registrations) },
  { key: "testes", label: "Testes iniciados", value: (n) => int(n.trials) },
  { key: "vendas", label: "Vendas aprovadas", value: (n) => int(n.sales) },
  { key: "faturamento", label: "Faturamento", value: (n) => money(n.revenue_cents, n.currency) },
  { key: "gasto", label: "Gasto", value: (n) => money(n.spend_cents, n.currency) },
  { key: "roas", label: "ROAS", value: (n) => roas(n.roas) },
  { key: "roas_testes", label: "ROAS com testes", value: (n) => roas(n.trial_roas) },
  {
    key: "ganhos",
    label: "Ganhos (vendas + testes)",
    value: (n) => money(n.earnings_cents, n.currency),
  },
  {
    key: "valor_testes",
    label: "Valor dos testes",
    value: (n) => money(n.trial_value_cents, n.currency),
  },
  { key: "cpa", label: "CPA", value: (n) => money(n.cpa_cents, n.currency) },
  {
    key: "custo_cadastro",
    label: "Custo por cadastro",
    value: (n) => money(n.cost_per_registration_cents, n.currency),
  },
  {
    key: "custo_teste",
    label: "Custo por teste",
    value: (n) => money(n.cost_per_trial_cents, n.currency),
  },
  { key: "cliques", label: "Cliques no link", value: (n) => int(n.link_clicks) },
  { key: "impressoes", label: "Impressões", value: (n) => int(n.impressions) },
  { key: "dia", label: "Data (05/11)", value: (n) => shortDate(n.day) },
  { key: "dia_semana", label: "Dia da semana", value: (n) => weekday(n.day) },
  { key: "workspace", label: "Nome do workspace", value: (n) => n.workspace },
];

const BY_KEY = new Map(SUMMARY_VARIABLES.map((v) => [v.key, v]));

export const DEFAULT_TITLE = "📊 Resumo de {dia}";
export const DEFAULT_BODY =
  "Cadastros: {cadastros}\nTestes: {testes}\nVendas: {vendas} · {faturamento}\nGasto: {gasto} · ROAS {roas}";

/** Troca {variavel} pelo valor. Variável desconhecida fica como está, para a pessoa ver o erro. */
export function renderTemplate(template: string, numbers: DailySummaryNumbers): string {
  return template.replace(
    /\{([a-z_]+)\}/g,
    (match, key: string) => BY_KEY.get(key)?.value(numbers) ?? match,
  );
}

/** Variáveis escritas no modelo que não existem (para avisar no editor). */
export function unknownVariables(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(/\{([a-z_]+)\}/g)) if (!BY_KEY.has(m[1] ?? "")) found.add(m[0]);
  return [...found];
}

export function renderSummary(
  templates: { title: string; body: string },
  numbers: DailySummaryNumbers,
): { title: string; body: string } {
  return {
    title: renderTemplate(templates.title, numbers).trim().slice(0, 120),
    body: renderTemplate(templates.body, numbers).trim().slice(0, 1000),
  };
}
