/**
 * Cliente da Graph API da Meta: versão única, appsecret_proof, paginação,
 * leitura dos headers de uso (rate limit) e retry com backoff.
 */
import { hmacHex } from "../crypto.ts";

/** Única versão da Graph API usada pelo app. Ao migrar, troque só aqui. */
export const GRAPH_API_VERSION = "v25.0";
export const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
export const FACEBOOK_DIALOG_URL = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`;

export type MetaErrorKind = "token" | "rate_limit" | "transient" | "permission" | "other";

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    readonly subcode: number | null,
    readonly kind: MetaErrorKind,
    /** Segundos até a Meta liberar de novo (quando informado). */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

// https://developers.facebook.com/docs/graph-api/guides/error-handling
// https://developers.facebook.com/docs/marketing-api/overview/rate-limiting
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
const TOKEN_CODES = new Set([102, 190]);
const TOKEN_SUBCODES = new Set([458, 459, 460, 463, 464, 467, 492]);
const PERMISSION_CODES = new Set([10, 200, 294]);

export function classifyMetaError(status: number, code: number | null, subcode: number | null): MetaErrorKind {
  if (code !== null && TOKEN_CODES.has(code)) return "token";
  if (subcode !== null && TOKEN_SUBCODES.has(subcode)) return "token";
  if (code !== null && RATE_LIMIT_CODES.has(code)) return "rate_limit";
  if (status === 429) return "rate_limit";
  if (code !== null && PERMISSION_CODES.has(code)) return "permission";
  if (code === 1 || code === 2 || status >= 500) return "transient";
  return "other";
}

export type Usage = {
  /** Maior percentual entre call_count, total_cputime e total_time de todos os headers. */
  maxPercent: number;
  /** Maior estimated_time_to_regain_access (em segundos), se a Meta bloqueou. */
  regainSeconds: number;
};

function asNumber(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Lê x-business-use-case-usage, x-ad-account-usage e x-app-usage. */
export function parseUsage(headers: Headers): Usage {
  let maxPercent = 0;
  let regainSeconds = 0;
  const bump = (entry: Record<string, unknown>) => {
    for (const key of ["call_count", "total_cputime", "total_time", "acc_id_util_pct"]) {
      maxPercent = Math.max(maxPercent, asNumber(entry[key]));
    }
    // BUC informa em minutos; x-ad-account-usage informa reset_time_duration em segundos.
    regainSeconds = Math.max(regainSeconds, asNumber(entry.estimated_time_to_regain_access) * 60);
    if (asNumber(entry.acc_id_util_pct) >= 100) regainSeconds = Math.max(regainSeconds, asNumber(entry.reset_time_duration));
  };
  const read = (name: string) => {
    const raw = headers.get(name);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) parsed.forEach((e) => e && typeof e === "object" && bump(e as Record<string, unknown>));
      else if (parsed && typeof parsed === "object") {
        const values = Object.values(parsed as Record<string, unknown>);
        // BUC: { "<account_id>": [ {...}, ... ] }. Os outros: objeto plano.
        if (values.some(Array.isArray)) {
          for (const v of values) if (Array.isArray(v)) v.forEach((e) => e && typeof e === "object" && bump(e));
        } else bump(parsed as Record<string, unknown>);
      }
    } catch {
      // header malformado: ignora
    }
  };
  read("x-business-use-case-usage");
  read("x-ad-account-usage");
  read("x-app-usage");
  return { maxPercent, regainSeconds };
}

export type GraphClientOptions = {
  accessToken: string;
  appSecret?: string | null;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** Chamado a cada resposta, para o chamador desacelerar perto do limite. */
  onUsage?: (usage: Usage) => void;
};

type GraphPage<T> = { data?: T[]; paging?: { next?: string } };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GraphClient {
  private proof: Promise<string | null>;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly options: GraphClientOptions) {
    this.proof = options.appSecret ? hmacHex("SHA-256", options.appSecret, options.accessToken) : Promise.resolve(null);
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 3;
  }

  private async buildUrl(pathOrUrl: string, params: Record<string, string | number>): Promise<URL> {
    const url = pathOrUrl.startsWith("https://")
      ? new URL(pathOrUrl)
      : new URL(`${GRAPH_BASE_URL}/${pathOrUrl.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set("access_token", this.options.accessToken);
    const proof = await this.proof;
    if (proof) url.searchParams.set("appsecret_proof", proof);
    return url;
  }

  /** GET com retry exponencial (2s, 4s, 8s) em erro transitório ou rate limit curto. */
  async get<T>(pathOrUrl: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = await this.buildUrl(pathOrUrl, params);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchFn(url, { headers: { accept: "application/json" } });
      } catch (cause) {
        if (attempt >= this.maxRetries) {
          throw new MetaApiError(`Falha de rede com a Meta: ${String(cause)}`, 0, null, null, "transient");
        }
        await this.sleep(2000 * 2 ** attempt);
        continue;
      }
      const usage = parseUsage(response.headers);
      this.options.onUsage?.(usage);
      const body = (await response.json().catch(() => null)) as
        | (T & { error?: { message?: string; code?: number; error_subcode?: number } })
        | null;
      if (response.ok && body && !body.error) return body;

      const err = body?.error;
      const code = typeof err?.code === "number" ? err.code : null;
      const subcode = typeof err?.error_subcode === "number" ? err.error_subcode : null;
      const kind = classifyMetaError(response.status, code, subcode);
      const error = new MetaApiError(
        err?.message ?? `HTTP ${response.status}`,
        response.status,
        code,
        subcode,
        kind,
        usage.regainSeconds || null,
      );
      const waitMs = 2000 * 2 ** attempt;
      // Rate limit longo (minutos) não adianta esperar aqui: o chamador pausa a conta.
      const retryable = kind === "transient" || (kind === "rate_limit" && usage.regainSeconds * 1000 <= waitMs);
      if (!retryable || attempt >= this.maxRetries) throw error;
      await this.sleep(waitMs);
    }
  }

  /** Percorre todas as páginas (paging.next), com limite de segurança. */
  async *paginate<T>(path: string, params: Record<string, string | number> = {}, maxPages = 200): AsyncGenerator<T[]> {
    let page = await this.get<GraphPage<T>>(path, params);
    for (let i = 0; i < maxPages; i++) {
      yield page.data ?? [];
      const next = page.paging?.next;
      if (!next) return;
      // O `next` já traz os parâmetros; o token e o proof são repostos por buildUrl.
      page = await this.get<GraphPage<T>>(next);
    }
  }
}
