/** Validação do evento que o script nishistack-ads.js manda. Sem Deno, para testar no Vitest. */

export const KEY_PATTERN = /^[0-9a-f]{64}$/;
export const EVENT_PATTERN = /^[a-z0-9_]{1,40}$/;
export const MAX_BODY_BYTES = 8_000;

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

export type TrackedEvent = {
  event: string;
  dedupe_key: string;
  visitor_id: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  fbclid: string | null;
  landing_url: string | null;
  touched_at: string | null;
};

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/** "Cadastro" → "cadastro"; "Início de teste" → "inicio_de_teste". */
export function normalizeEventName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return EVENT_PATTERN.test(name) ? name : null;
}

/** Corpo do envio → chave da fonte e evento, ou o motivo da recusa. */
export function parseTrackBody(
  raw: string,
): { ok: true; key: string; event: TrackedEvent } | { ok: false; error: string } {
  if (raw.length > MAX_BODY_BYTES) return { ok: false, error: "payload_too_large" };
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { ok: false, error: "invalid_body" };
    body = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: "invalid_body" };
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!KEY_PATTERN.test(key)) return { ok: false, error: "invalid_key" };
  const event = normalizeEventName(body.event);
  if (!event) return { ok: false, error: "invalid_event" };
  // O id que o app mandou (ex.: id do usuário) vale mais que o id do envio: o mesmo
  // cadastro mandado duas vezes conta uma só.
  const dedupe = text(body.id, 200) ?? text(body.event_id, 200);
  if (!dedupe) return { ok: false, error: "missing_id" };

  const touch =
    body.touch && typeof body.touch === "object" ? (body.touch as Record<string, unknown>) : {};
  const touchedAt = text(touch.at, 40);
  const utm = Object.fromEntries(UTM_KEYS.map((k) => [k, text(touch[k], 500)])) as Record<
    (typeof UTM_KEYS)[number],
    string | null
  >;
  return {
    ok: true,
    key,
    event: {
      event,
      dedupe_key: dedupe,
      visitor_id: text(body.visitor, 100),
      ...utm,
      fbclid: text(touch.fbclid, 500),
      landing_url: text(touch.url, 1000),
      touched_at:
        touchedAt && !Number.isNaN(Date.parse(touchedAt))
          ? new Date(touchedAt).toISOString()
          : null,
    },
  };
}
