/** Períodos do filtro global, calculados no fuso do workspace e devolvidos em UTC (ISO). */

export type PeriodKey = "today" | "yesterday" | "7d" | "30d" | "custom";

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: "Hoje",
  yesterday: "Ontem",
  "7d": "Últimos 7 dias",
  "30d": "Últimos 30 dias",
  custom: "Personalizado",
};

export type DateRange = { from: string; to: string };

/** "YYYY-MM-DD" do instante no fuso informado. */
export function ymdInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant;
}

/** Instante (UTC) da meia-noite de `ymd` no fuso informado. */
export function startOfDayInZone(ymd: string, timeZone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let instant = guess - zoneOffsetMs(guess, timeZone);
  instant = guess - zoneOffsetMs(instant, timeZone);
  return new Date(instant);
}

export function periodRange(
  period: PeriodKey,
  timeZone: string,
  now: Date = new Date(),
  custom?: { from: string; to: string },
): DateRange {
  const today = ymdInZone(now, timeZone);
  const span = (firstDay: string, lastDay: string): DateRange => ({
    from: startOfDayInZone(firstDay, timeZone).toISOString(),
    to: startOfDayInZone(addDays(lastDay, 1), timeZone).toISOString(),
  });
  switch (period) {
    case "today":
      return span(today, today);
    case "yesterday":
      return span(addDays(today, -1), addDays(today, -1));
    case "7d":
      return span(addDays(today, -6), today);
    case "30d":
      return span(addDays(today, -29), today);
    case "custom": {
      const from = custom?.from || today;
      const to = custom?.to && custom.to >= from ? custom.to : from;
      return span(from, to);
    }
  }
}

/** Dias (YYYY-MM-DD, inclusive) do período no fuso informado: a mesma regra de periodRange. */
export function periodDays(
  period: PeriodKey,
  timeZone: string,
  now: Date = new Date(),
  custom?: { from: string; to: string },
): { first: string; last: string } {
  const today = ymdInZone(now, timeZone);
  switch (period) {
    case "today":
      return { first: today, last: today };
    case "yesterday":
      return { first: addDays(today, -1), last: addDays(today, -1) };
    case "7d":
      return { first: addDays(today, -6), last: today };
    case "30d":
      return { first: addDays(today, -29), last: today };
    case "custom": {
      const first = custom?.from || today;
      const last = custom?.to && custom.to >= first ? custom.to : first;
      return { first, last };
    }
  }
}

/** Quantidade de dias entre dois YYYY-MM-DD, contando os dois. */
export function daySpan(first: string, last: string): number {
  return Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1;
}

/** O período de mesmo tamanho logo antes: base das comparações. */
export function previousDays(days: { first: string; last: string }): { first: string; last: string } {
  const span = daySpan(days.first, days.last);
  return { first: addDays(days.first, -span), last: addDays(days.first, -1) };
}

/** Dias de first a last, inclusive. */
export function eachDay(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Intervalo UTC (ISO) que cobre os dias informados no fuso. */
export function daysToRange(days: { first: string; last: string }, timeZone: string): DateRange {
  return {
    from: startOfDayInZone(days.first, timeZone).toISOString(),
    to: startOfDayInZone(addDays(days.last, 1), timeZone).toISOString(),
  };
}
