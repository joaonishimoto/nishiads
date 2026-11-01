/**
 * Leitura de cada criativo (anúncio) na aba Criativos: funil, custos e um veredito de
 * escalar ou pausar. Funções puras sobre as métricas já somadas da árvore.
 */
import { actionValue } from "@/features/results/meta-actions";
import { derived, type NodeMetrics } from "@/features/results/metrics";

/**
 * Cadastros do criativo. O rastreamento próprio (nishistack('cadastro')) vale mais que o
 * que a Meta atribui, porque conta quem de fato criou a conta no app.
 */
export function registrationsOf(m: NodeMetrics): {
  count: number;
  source: "rastreio" | "meta" | null;
} {
  const tracked = m.tracked["cadastro"] ?? 0;
  if (tracked > 0) return { count: tracked, source: "rastreio" };
  if (m.registrations > 0) return { count: m.registrations, source: "meta" };
  return { count: 0, source: null };
}

const ratio = (n: number, d: number) => (d > 0 ? n / d : null);
const costPer = (m: NodeMetrics, n: number) =>
  n > 0 && m.spendCents > 0 ? Math.round(m.spendCents / n) : null;

export const creative = {
  cpm: (m: NodeMetrics) =>
    m.impressions > 0 ? Math.round((m.spendCents / m.impressions) * 1000) : null,
  /** Visualizações de 3 s ÷ impressões: quanto o começo do vídeo segura. */
  hookRate: (m: NodeMetrics) => ratio(actionValue(m.actions, ["video_view"]), m.impressions),
  /** Páginas carregadas ÷ cliques no link: quem clicou e de fato chegou. */
  landingRate: (m: NodeMetrics) =>
    ratio(actionValue(m.actions, ["omni_landing_page_view", "landing_page_view"]), m.linkClicks),
  registrationRate: (m: NodeMetrics) => ratio(registrationsOf(m).count, m.linkClicks),
  saleRate: (m: NodeMetrics) => ratio(m.sales, m.linkClicks),
  costPerRegistration: (m: NodeMetrics) => costPer(m, registrationsOf(m).count),
  engagement: (m: NodeMetrics) => actionValue(m.actions, ["post_engagement"]),
};

export type Verdict = "scale" | "watch" | "loss" | "pause" | "learning" | "idle";

/**
 * O que fazer com o criativo. Sem venda, compara o gasto com o CPA médio dos criativos:
 * quem já gastou mais que uma venda média sem vender é candidato a pausar.
 */
export function verdictOf(m: NodeMetrics, target: number, avgCpaCents: number | null): Verdict {
  if (m.spendCents <= 0) return "idle";
  if (m.sales === 0) {
    return avgCpaCents !== null && m.spendCents >= avgCpaCents ? "pause" : "learning";
  }
  const roas = derived.roas(m) ?? 0;
  if (roas >= target) return "scale";
  if (roas >= 1) return "watch";
  return "loss";
}

/** CPA médio dos criativos (gasto total ÷ vendas totais), a régua do "sem venda". */
export function averageCpa(metrics: NodeMetrics[]): number | null {
  let spend = 0;
  let sales = 0;
  for (const m of metrics) {
    spend += m.spendCents;
    sales += m.sales;
  }
  return sales > 0 && spend > 0 ? Math.round(spend / sales) : null;
}
