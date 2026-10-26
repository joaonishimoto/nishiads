/**
 * Dados de clique da Meta que o checkout repassa (metadata da Stripe, parâmetros de
 * rastreamento da Kiwify): cookies _fbc e _fbp, ou o fbclid da URL, e o user agent.
 * Vão para a Conversions API e melhoram muito o casamento da venda com o clique.
 */
import { cleanText } from "../values.ts";

const FBC = /^fb\.\d\.\d+\..+$/;
const FBP = /^fb\.\d\.\d+\.\d+$/;
// fbclid chega como está na URL; a Meta pede que não seja alterado.
const FBCLID = /^[A-Za-z0-9_-]{8,400}$/;

export interface ClickIds {
  fbc: string | null;
  fbp: string | null;
  client_user_agent: string | null;
}

function pick(source: Record<string, unknown>, keys: string[], max: number): string | null {
  for (const key of keys) {
    const value = cleanText(source[key], max);
    if (value) return value;
  }
  return null;
}

/**
 * @param observedAtMs quando o fbclid foi visto (usado só para montar o fbc a partir dele).
 */
export function clickIdsFrom(source: unknown, observedAtMs: number): ClickIds {
  const record =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : null;
  if (!record) return { fbc: null, fbp: null, client_user_agent: null };

  let fbc = pick(record, ["fbc", "_fbc"], 500);
  if (fbc && !FBC.test(fbc)) fbc = null;
  if (!fbc) {
    const fbclid = pick(record, ["fbclid"], 400);
    // Formato fb.{subdomainIndex}.{creationTime}.{fbclid}; no servidor, subdomainIndex = 1.
    if (fbclid && FBCLID.test(fbclid) && Number.isFinite(observedAtMs) && observedAtMs > 0) {
      fbc = `fb.1.${Math.floor(observedAtMs)}.${fbclid}`;
    }
  }
  let fbp = pick(record, ["fbp", "_fbp"], 200);
  if (fbp && !FBP.test(fbp)) fbp = null;

  return { fbc, fbp, client_user_agent: pick(record, ["client_user_agent", "user_agent"], 500) };
}
