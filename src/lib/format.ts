/** Formatação pt-BR. Valores monetários chegam em centavos; datas em ISO (UTC). */

export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

const moneyFormatters = new Map<string, Intl.NumberFormat>();

export function formatMoney(cents: number, currency = "BRL"): string {
  let formatter = moneyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency });
    moneyFormatters.set(currency, formatter);
  }
  return formatter.format(cents / 100);
}

export function formatDateTime(iso: string, timeZone = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone,
  }).format(new Date(iso));
}

export function formatDate(iso: string, timeZone = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeZone }).format(new Date(iso));
}

/** plural(2, "membro", "membros") → "2 membros" */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count.toLocaleString("pt-BR")} ${count === 1 ? singular : pluralForm}`;
}
