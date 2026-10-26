/** Textos do push dos alertas. Funções puras, testadas em messages.test.ts. */
import { formatMoney, type PushPayload } from "../notify/messages.ts";

export type AlertCondition = "spend_without_sale" | "roas_below" | "cpa_above";
export type AlertLevel = "campaign" | "adset" | "ad";
export type AlertWindow = "today" | "last_3d" | "last_7d";
export type AlertStatus = "notified" | "pending" | "pausing" | "paused" | "dismissed" | "expired";

/** Linha de public.alerts (o que a avaliação devolve). */
export type AlertRow = {
  id: string;
  workspace_id: string;
  rule_id: string | null;
  rule_name: string;
  condition: AlertCondition;
  level: AlertLevel;
  time_window: AlertWindow;
  action: "notify" | "approve_pause" | "auto_pause";
  threshold_cents: number | null;
  min_roas: number | string | null;
  ad_account_id: string;
  object_id: string;
  object_external_id: string;
  object_name: string;
  currency: string;
  spend_cents: number;
  sales: number;
  revenue_cents: number;
  roas: number | string | null;
  cpa_cents: number | null;
  status: AlertStatus;
  auto_action: boolean;
  error: string | null;
};

export const LEVEL_LABEL: Record<AlertLevel, string> = { campaign: "Campanha", adset: "Conjunto", ad: "Anúncio" };
export const WINDOW_LABEL: Record<AlertWindow, string> = {
  today: "hoje",
  last_3d: "últimos 3 dias",
  last_7d: "últimos 7 dias",
};

/** O Postgres devolve numeric como texto pelo PostgREST. */
function num(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

export function formatRoas(value: number | string | null): string {
  const n = num(value) ?? 0;
  return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(n);
}

/** Frase curta do que aconteceu, ex.: "Gastou R$ 150,00 sem venda". */
export function alertHeadline(a: AlertRow): string {
  const money = (cents: number) => formatMoney(cents, a.currency);
  switch (a.condition) {
    case "spend_without_sale":
      return `Gastou ${money(a.spend_cents)} sem venda`;
    case "roas_below":
      return `ROAS ${formatRoas(a.roas)}, abaixo da meta de ${formatRoas(a.min_roas)}`;
    case "cpa_above":
      return a.sales > 0 && a.cpa_cents !== null
        ? `CPA ${money(a.cpa_cents)}, acima do máximo de ${money(a.threshold_cents ?? 0)}`
        : `Gastou ${money(a.spend_cents)} sem venda (CPA máximo ${money(a.threshold_cents ?? 0)})`;
  }
}

const ICON: Record<AlertCondition, string> = { spend_without_sale: "🚨", roas_below: "📉", cpa_above: "💸" };

function outcomeLine(a: AlertRow): string {
  if (a.status === "paused") return `⏸️ Pausado automaticamente pela regra “${a.rule_name}”.`;
  if (a.status === "pending" && a.auto_action) return `Não consegui pausar: ${a.error ?? "erro na Meta"}. Toque para tentar de novo.`;
  if (a.status === "pending") return a.error ? `${a.error}` : "Toque para pausar ou ignorar.";
  return `Regra “${a.rule_name}”.`;
}

export function alertPushPayload(a: AlertRow): PushPayload {
  const paused = a.status === "paused";
  const pending = a.status === "pending";
  return {
    title: `${paused ? "⏸️" : ICON[a.condition]} ${alertHeadline(a)}`,
    body: [`${LEVEL_LABEL[a.level]} “${a.object_name}” · ${WINDOW_LABEL[a.time_window]}`, outcomeLine(a)].join("\n"),
    url: `/w/${a.workspace_id}/alertas?alerta=${a.id}`,
    tag: `alert:${a.id}`,
    ...(pending ? { actions: [{ action: "pause", title: "Pausar" }] } : {}),
  };
}

/** Muitos alertas de uma vez viram um push só. */
export const MAX_INDIVIDUAL_PUSHES = 3;

export function alertsSummaryPayload(workspaceId: string, alerts: AlertRow[], now = Date.now()): PushPayload {
  const paused = alerts.filter((a) => a.status === "paused").length;
  const pending = alerts.filter((a) => a.status === "pending").length;
  const parts = [
    paused ? `${paused} ${paused === 1 ? "pausado" : "pausados"}` : null,
    pending ? `${pending} esperando aprovação` : null,
  ].filter(Boolean);
  const lines = alerts.slice(0, 3).map((a) => `• ${a.object_name}: ${alertHeadline(a)}`);
  if (alerts.length > 3) lines.push(`e mais ${alerts.length - 3}`);
  return {
    title: `🔔 ${alerts.length} alertas novos${parts.length ? ` (${parts.join(", ")})` : ""}`,
    body: lines.join("\n"),
    url: `/w/${workspaceId}/alertas`,
    tag: `alerts:${workspaceId}:${now}`,
  };
}
