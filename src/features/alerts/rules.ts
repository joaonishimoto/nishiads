/**
 * Regras de alerta no app: rascunho do formulário, validação, descrição em pt-BR e
 * modelos prontos. Funções puras (testadas em src/test/alerts.test.ts).
 */
import { formatMoney } from "@/lib/format";
import type {
  AlertAction,
  AlertCondition,
  AlertLevel,
  AlertStatus,
  AlertWindow,
  Tables,
} from "@/types/database";

export type AlertRule = Tables<"alert_rules">;
export type Alert = Tables<"alerts">;

export const CONDITION_LABEL: Record<AlertCondition, string> = {
  spend_without_sale: "Gastou sem vender",
  roas_below: "ROAS abaixo da meta",
  cpa_above: "CPA acima do máximo",
};

export const LEVEL_LABEL: Record<AlertLevel, string> = {
  campaign: "Campanha",
  adset: "Conjunto",
  ad: "Anúncio",
};

/** Plural, para frases como "Anúncios que…". */
export const LEVEL_PLURAL: Record<AlertLevel, string> = {
  campaign: "Campanhas",
  adset: "Conjuntos",
  ad: "Anúncios",
};

export const WINDOW_LABEL: Record<AlertWindow, string> = {
  today: "hoje",
  last_3d: "nos últimos 3 dias",
  last_7d: "nos últimos 7 dias",
};

export const WINDOW_OPTION: Record<AlertWindow, string> = {
  today: "Hoje",
  last_3d: "Últimos 3 dias",
  last_7d: "Últimos 7 dias",
};

export const ACTION_LABEL: Record<AlertAction, string> = {
  notify: "Só avisar",
  approve_pause: "Avisar e pedir para pausar",
  auto_pause: "Pausar sozinho",
};

export const STATUS_LABEL: Record<AlertStatus, string> = {
  notified: "Aviso",
  pending: "Esperando aprovação",
  pausing: "Pausando…",
  paused: "Pausado",
  dismissed: "Ignorado",
  expired: "Expirou",
};

/** Formulário: valores em reais (números) e ROAS como texto digitado. */
export type RuleDraft = {
  name: string;
  enabled: boolean;
  condition: AlertCondition;
  level: AlertLevel;
  time_window: AlertWindow;
  threshold: number;
  min_roas: string;
  min_spend: number;
  action: AlertAction;
  max_auto_pauses_per_day: number;
  ad_account_id: string | null;
  campaign_id: string | null;
};

export type RuleValues = Pick<
  AlertRule,
  | "name"
  | "enabled"
  | "condition"
  | "level"
  | "time_window"
  | "threshold_cents"
  | "min_roas"
  | "min_spend_cents"
  | "action"
  | "max_auto_pauses_per_day"
  | "ad_account_id"
  | "campaign_id"
>;

export const EMPTY_DRAFT: RuleDraft = {
  name: "",
  enabled: true,
  condition: "spend_without_sale",
  level: "ad",
  time_window: "today",
  threshold: 100,
  min_roas: "",
  min_spend: 0,
  action: "approve_pause",
  max_auto_pauses_per_day: 3,
  ad_account_id: null,
  campaign_id: null,
};

export type RulePreset = { key: string; title: string; description: string; draft: RuleDraft };

/** Modelos para quem ainda não tem regra. Os valores são editáveis no formulário. */
export const RULE_PRESETS: RulePreset[] = [
  {
    key: "spend",
    title: "Anúncio gastou R$ 100 sem venda",
    description: "Avisa e pede sua aprovação para pausar.",
    draft: { ...EMPTY_DRAFT, name: "Anúncio sem venda", threshold: 100 },
  },
  {
    key: "roas",
    title: "ROAS do conjunto abaixo de 1,5 hoje",
    description: "Só avisa, depois de gastar R$ 50.",
    draft: {
      ...EMPTY_DRAFT,
      name: "ROAS baixo no conjunto",
      condition: "roas_below",
      level: "adset",
      min_roas: "1,5",
      min_spend: 50,
      threshold: 0,
      action: "notify",
    },
  },
  {
    key: "cpa",
    title: "CPA do anúncio acima do máximo",
    description: "Pausa sozinho, até 3 por dia. Ajuste o CPA ao seu produto.",
    draft: {
      ...EMPTY_DRAFT,
      name: "CPA máximo",
      condition: "cpa_above",
      threshold: 80,
      action: "auto_pause",
    },
  },
];

const cents = (reais: number) => Math.round(reais * 100);

export function parseRoas(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(normalized)) return null;
  const n = Number(normalized);
  return n > 0 && n <= 100 ? n : null;
}

export function formatRoasInput(value: number | null): string {
  return value === null ? "" : String(value).replace(".", ",");
}

export function ruleToDraft(rule: AlertRule): RuleDraft {
  return {
    name: rule.name,
    enabled: rule.enabled,
    condition: rule.condition,
    level: rule.level,
    time_window: rule.time_window,
    threshold: (rule.threshold_cents ?? 0) / 100,
    min_roas: formatRoasInput(rule.min_roas === null ? null : Number(rule.min_roas)),
    min_spend: rule.min_spend_cents / 100,
    action: rule.action,
    max_auto_pauses_per_day: rule.max_auto_pauses_per_day,
    ad_account_id: rule.ad_account_id,
    campaign_id: rule.campaign_id,
  };
}

export type RuleErrors = Partial<Record<"name" | "threshold" | "min_roas" | "min_spend" | "max_auto_pauses_per_day", string>>;

/** Valida o rascunho e devolve as colunas da tabela (dinheiro em centavos). */
export function validateRule(draft: RuleDraft): { values?: RuleValues; errors: RuleErrors } {
  const errors: RuleErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = "Dê um nome para a regra.";
  else if (name.length > 80) errors.name = "Use até 80 caracteres.";

  const roas = draft.condition === "roas_below" ? parseRoas(draft.min_roas) : null;
  if (draft.condition === "roas_below" && roas === null) errors.min_roas = "Informe um ROAS entre 0,01 e 100, como 1,5.";
  if (draft.condition !== "roas_below" && !(draft.threshold > 0)) {
    errors.threshold = draft.condition === "cpa_above" ? "Informe o CPA máximo." : "Informe quanto pode gastar sem vender.";
  }
  if (draft.threshold > 1_000_000) errors.threshold = "Use um valor até R$ 1.000.000.";
  if (draft.min_spend < 0 || draft.min_spend > 1_000_000) errors.min_spend = "Use um valor até R$ 1.000.000.";
  const max = draft.max_auto_pauses_per_day;
  if (draft.action === "auto_pause" && (!Number.isInteger(max) || max < 1 || max > 50)) {
    errors.max_auto_pauses_per_day = "Entre 1 e 50.";
  }
  if (Object.keys(errors).length) return { errors };

  return {
    errors,
    values: {
      name,
      enabled: draft.enabled,
      condition: draft.condition,
      level: draft.level,
      time_window: draft.time_window,
      threshold_cents: draft.condition === "roas_below" ? null : cents(draft.threshold),
      min_roas: roas,
      // "Gastou sem vender" já tem o próprio valor de gasto.
      min_spend_cents: draft.condition === "spend_without_sale" ? 0 : cents(draft.min_spend),
      action: draft.action,
      max_auto_pauses_per_day: draft.action === "auto_pause" ? max : 3,
      ad_account_id: draft.ad_account_id,
      campaign_id: draft.campaign_id,
    },
  };
}

function roasText(value: number | string | null): string {
  const n = value === null ? 0 : Number(value);
  return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(n);
}

/** Uma frase para a lista: "Anúncios que gastaram R$ 100,00 sem venda hoje". */
export function describeRule(
  rule: Pick<AlertRule, "condition" | "level" | "time_window" | "threshold_cents" | "min_roas" | "min_spend_cents">,
  currency: string,
): string {
  const who = LEVEL_PLURAL[rule.level];
  const when = WINDOW_LABEL[rule.time_window];
  const money = (c: number | null) => formatMoney(c ?? 0, currency);
  const after = rule.min_spend_cents > 0 ? `, depois de gastar ${money(rule.min_spend_cents)}` : "";
  switch (rule.condition) {
    case "spend_without_sale":
      return `${who} que gastaram ${money(rule.threshold_cents)} sem venda ${when}`;
    case "roas_below":
      return `${who} com ROAS abaixo de ${roasText(rule.min_roas)} ${when}${after}`;
    case "cpa_above":
      return `${who} com CPA acima de ${money(rule.threshold_cents)} ${when}${after}`;
  }
}

/** O que aconteceu, para o cartão do alerta. */
export function alertHeadline(alert: Alert): string {
  const money = (c: number | null) => formatMoney(c ?? 0, alert.currency);
  switch (alert.condition) {
    case "spend_without_sale":
      return `Gastou ${money(alert.spend_cents)} sem venda`;
    case "roas_below":
      return `ROAS ${roasText(alert.roas)}, abaixo da meta de ${roasText(alert.min_roas)}`;
    case "cpa_above":
      return alert.sales > 0 && alert.cpa_cents !== null
        ? `CPA ${money(alert.cpa_cents)}, acima do máximo de ${money(alert.threshold_cents)}`
        : `Gastou ${money(alert.spend_cents)} sem venda (CPA máximo ${money(alert.threshold_cents)})`;
  }
}

/**
 * Período do alerta em relação a hoje: "hoje" só vale no próprio dia; depois vira
 * "em 24/10" ou "nos 3 dias até 24/10".
 */
export function alertWindowText(alert: Pick<Alert, "time_window" | "period_key">, todayKey: string): string {
  if (alert.period_key === todayKey) return WINDOW_LABEL[alert.time_window];
  const [, m, d] = alert.period_key.split("-");
  const day = `${d}/${m}`;
  if (alert.time_window === "today") return `em ${day}`;
  return `nos ${alert.time_window === "last_3d" ? 3 : 7} dias até ${day}`;
}

/** Pedidos e avisos valem por 24 horas (o servidor recusa depois disso). */
export const ALERT_TTL_MS = 24 * 60 * 60 * 1000;

/** Ainda dá para pausar pelo app. */
export function canPause(alert: Pick<Alert, "status" | "created_at">, now = Date.now()): boolean {
  return (
    (alert.status === "pending" || alert.status === "notified") &&
    now - new Date(alert.created_at).getTime() <= ALERT_TTL_MS
  );
}
