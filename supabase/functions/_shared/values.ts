/** Conversões tolerantes para payloads de provedores. */

/** Inteiro em centavos a partir de número ou string só com dígitos. */
export function parseCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

/** Valor em reais (197, "197.00", "197,00") para centavos. */
export function reaisToCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value * 100);
  if (typeof value === "string") {
    const normalized = value.trim().replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
    const parsed = Number(normalized);
    if (normalized !== "" && Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed * 100);
  }
  return null;
}

/**
 * Data do provedor para ISO (UTC). Aceita ISO com fuso ou "YYYY-MM-DD HH:mm[:ss]"
 * sem fuso, interpretado no fuso informado (Brasília não tem horário de verão desde 2019).
 */
export function parseProviderDate(value: unknown, offsetWithoutZone = "-03:00"): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/.exec(text);
  const candidate = local ? `${local[1]}T${local[2]}${local[3] ?? ":00"}${offsetWithoutZone}` : text;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function cleanText(value: unknown, max = 500): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}
