/** Conversões puras dos dados da Meta para o formato do banco (testadas sem rede). */

export const BACKFILL_DAYS = 30;
export const REFRESH_DAYS = 3;
/** Janela de cada chamada de insights: menos dados por resposta, menos timeout na Meta. */
export const INSIGHTS_CHUNK_DAYS = 10;

/** "12.34" (moeda da conta) → 1234 centavos. */
export function toCents(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

export function toCount(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function toNullableCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  return toCents(value);
}

/** Data de hoje (YYYY-MM-DD) no fuso da conta de anúncio. */
export function todayIn(timezone: string | null | undefined, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "America/Sao_Paulo" }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
  }
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Período a buscar: backfill de 30 dias na primeira vez, depois os últimos 3 dias. */
export function insightsWindow(
  account: { timezone: string | null; backfilled_at: string | null },
  now = new Date(),
): { since: string; until: string; backfill: boolean } {
  const until = todayIn(account.timezone, now);
  const backfill = account.backfilled_at === null;
  return { since: addDays(until, -((backfill ? BACKFILL_DAYS : REFRESH_DAYS) - 1)), until, backfill };
}

/** Divide [since, until] em janelas de até `days` dias, da mais recente para a mais antiga. */
export function dateChunks(since: string, until: string, days = INSIGHTS_CHUNK_DAYS): { since: string; until: string }[] {
  const chunks: { since: string; until: string }[] = [];
  let end = until;
  while (end >= since) {
    const start = addDays(end, -(days - 1));
    chunks.push({ since: start < since ? since : start, until: end });
    end = addDays(end, -days);
  }
  return chunks;
}

// https://developers.facebook.com/docs/marketing-api/reference/ad-account/ (account_status)
export function accountStatusFromMeta(accountStatus: number | null | undefined): "active" | "disabled" {
  return accountStatus === 2 || accountStatus === 100 || accountStatus === 101 ? "disabled" : "active";
}

export type MetaInsightRow = {
  date_start: string;
  ad_id: string;
  ad_name?: string;
  adset_id: string;
  adset_name?: string;
  campaign_id: string;
  campaign_name?: string;
  account_currency?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  inline_link_clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
};

export const INSIGHT_FIELDS = [
  "date_start",
  "ad_id",
  "ad_name",
  "adset_id",
  "adset_name",
  "campaign_id",
  "campaign_name",
  "account_currency",
  "spend",
  "impressions",
  "reach",
  "clicks",
  "inline_link_clicks",
  "ctr",
  "cpc",
  "cpm",
].join(",");

export type InsightValues = {
  date: string;
  currency: string;
  spend_cents: number;
  impressions: number;
  reach: number;
  clicks: number;
  link_clicks: number;
  ctr: number | null;
  cpc_cents: number | null;
  cpm_cents: number | null;
};

export function mapInsight(row: MetaInsightRow, fallbackCurrency: string): InsightValues {
  const ctr = row.ctr === undefined || row.ctr === "" ? null : Number(row.ctr);
  return {
    date: row.date_start,
    currency: (row.account_currency || fallbackCurrency || "BRL").toUpperCase().slice(0, 3),
    spend_cents: toCents(row.spend),
    impressions: toCount(row.impressions),
    reach: toCount(row.reach),
    clicks: toCount(row.clicks),
    link_clicks: toCount(row.inline_link_clicks),
    ctr: ctr !== null && Number.isFinite(ctr) ? Math.round(ctr * 1e6) / 1e6 : null,
    cpc_cents: toNullableCents(row.cpc),
    cpm_cents: toNullableCents(row.cpm),
  };
}

/** "act_123" ou "123" → "123" (o banco guarda só os dígitos). */
export function normalizeAccountId(id: string): string {
  return id.replace(/^act_/, "");
}
