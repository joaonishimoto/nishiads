/**
 * Conversions API da Meta: monta o evento de servidor a partir da venda e envia ao
 * pixel (conjunto de dados) do workspace.
 *
 * https://developers.facebook.com/docs/marketing-api/conversions-api
 * - Um evento por requisição: se um evento do lote é inválido, a Meta recusa o lote.
 * - event_id = id do pedido no checkout: a Meta guarda só a 1ª cópia de cada
 *   event_name + event_id (reenvios e o mesmo evento vindo do pixel do site).
 * - event_time até 7 dias atrás; mais velho que isso, a Meta recusa.
 * - Dados pessoais só com SHA-256: e-mail (já guardado assim) e external_id.
 *   fbc, fbp e user agent vão sem hash, como a Meta pede.
 */
import { sha256Hex } from "../crypto.ts";
import { classifyMetaError, GRAPH_BASE_URL, type MetaErrorKind } from "./graph.ts";

export const CAPI_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Margem para o evento não vencer no caminho. */
const AGE_MARGIN_MS = 10 * 60 * 1000;

export type CapiEventName = "Purchase" | "StartTrial" | "Refund";
export type ActionSource = "website" | "system_generated" | "other";

export interface CapiEventRow {
  id: number;
  workspace_id: string;
  sale_id: string | null;
  event_name: CapiEventName;
  event_id: string;
  event_time: string;
  is_test: boolean;
  attempts: number;
}

export interface CapiSale {
  id: string;
  external_order_id: string;
  gross_amount_cents: number;
  currency: string;
  external_product_id: string | null;
  product_name: string | null;
  customer_email_hash: string | null;
  fbc: string | null;
  fbp: string | null;
  client_user_agent: string | null;
  raw_payload: unknown;
}

export interface CapiCredentials {
  pixel_id: string;
  access_token: string;
  event_source_url: string;
  test_event_code: string | null;
}

export type ServerEvent = {
  event_name: CapiEventName;
  event_time: number;
  event_id: string;
  action_source: ActionSource;
  event_source_url?: string;
  user_data: Record<string, string | string[]>;
  custom_data: Record<string, unknown>;
};

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
}

/** Objeto do evento do checkout guardado na venda (Stripe: data.object). */
function providerObject(raw: unknown): Obj | null {
  const root = obj(raw);
  return obj(obj(root?.data)?.object) ?? root;
}

/** Renovação de assinatura (não foi uma compra no site): action_source system_generated. */
export function isRenewal(raw: unknown): boolean {
  return providerObject(raw)?.billing_reason === "subscription_cycle";
}

/** Cliente da Stripe (cus_...), estável entre as cobranças da assinatura. */
function customerRef(raw: unknown): string | null {
  const customer = providerObject(raw)?.customer;
  if (typeof customer === "string" && /^cus_[A-Za-z0-9]+$/.test(customer)) return customer;
  const id = obj(customer)?.id;
  return typeof id === "string" && /^cus_[A-Za-z0-9]+$/.test(id) ? id : null;
}

export type BuildResult = { kind: "event"; event: ServerEvent } | { kind: "skip"; reason: string };

/**
 * Evento de servidor de uma venda. `actionSource` força a origem (usado para reenviar
 * como "other" quando a Meta exige user agent num evento de site e a venda não tem).
 */
export async function buildServerEvent(
  row: Pick<CapiEventRow, "event_name" | "event_id" | "event_time">,
  sale: CapiSale,
  credentials: Pick<CapiCredentials, "event_source_url">,
  options: { now?: number; actionSource?: ActionSource } = {},
): Promise<BuildResult> {
  const now = options.now ?? Date.now();
  const eventTime = Date.parse(row.event_time);
  if (!Number.isFinite(eventTime)) return { kind: "skip", reason: "Data do evento inválida." };
  if (now - eventTime > CAPI_MAX_AGE_MS - AGE_MARGIN_MS) {
    return { kind: "skip", reason: "Passou de 7 dias: a Meta não aceita eventos mais antigos." };
  }

  const userData: Record<string, string | string[]> = {};
  if (sale.customer_email_hash && /^[0-9a-f]{64}$/.test(sale.customer_email_hash)) {
    userData.em = [sale.customer_email_hash];
  }
  const customer = customerRef(sale.raw_payload);
  if (customer) userData.external_id = [await sha256Hex(customer)];
  else if (userData.em) userData.external_id = userData.em;
  if (sale.fbc) userData.fbc = sale.fbc;
  if (sale.fbp) userData.fbp = sale.fbp;
  if (sale.client_user_agent) userData.client_user_agent = sale.client_user_agent;
  if (!userData.em && !userData.fbc && !userData.fbp && !userData.external_id) {
    return {
      kind: "skip",
      reason: "Venda sem e-mail nem dados de clique: a Meta não teria como casar.",
    };
  }

  const actionSource: ActionSource =
    options.actionSource ??
    (row.event_name === "Purchase" && isRenewal(sale.raw_payload) ? "system_generated" : "website");

  const currency = (sale.currency || "BRL").toUpperCase();
  const value = row.event_name === "StartTrial" ? 0 : Math.round(sale.gross_amount_cents) / 100;
  const customData: Record<string, unknown> = { currency, value, order_id: sale.external_order_id };
  if (sale.external_product_id) {
    customData.content_ids = [sale.external_product_id];
    customData.content_type = "product";
    customData.contents = [{ id: sale.external_product_id, quantity: 1, item_price: value }];
  }
  if (sale.product_name) customData.content_name = sale.product_name;

  const event: ServerEvent = {
    event_name: row.event_name,
    event_time: Math.floor(Math.min(eventTime, now) / 1000),
    event_id: row.event_id,
    action_source: actionSource,
    user_data: userData,
    custom_data: customData,
  };
  if (actionSource === "website") event.event_source_url = credentials.event_source_url;
  return { kind: "event", event };
}

/** Evento do botão "Enviar evento de teste": compra fictícia de R$ 1,00. */
export async function buildTestEvent(
  credentials: Pick<CapiCredentials, "event_source_url">,
  now = Date.now(),
) {
  const email = await sha256Hex("teste@nishiads.dev");
  const event: ServerEvent = {
    event_name: "Purchase",
    event_time: Math.floor(now / 1000),
    event_id: `teste-${crypto.randomUUID()}`,
    action_source: "website",
    event_source_url: credentials.event_source_url,
    user_data: {
      em: [email],
      external_id: [email],
      client_user_agent: "nishiADS (evento de teste)",
    },
    custom_data: {
      currency: "BRL",
      value: 1,
      order_id: "teste",
      content_name: "Evento de teste do nishiADS",
    },
  };
  return event;
}

export type CapiFailureKind = MetaErrorKind | "config";

export type SendOutcome =
  | { ok: true; response: Obj }
  | {
      ok: false;
      /** config: token, permissão ou pixel errados (vale para todos os eventos do workspace). */
      kind: CapiFailureKind;
      message: string;
      code: number | null;
      subcode: number | null;
      response: Obj | null;
      /** A Meta pediu user agent num evento de site. */
      needsUserAgent: boolean;
    };

/** Envia um evento. Nunca lança: falha de rede vira { ok: false, kind: "transient" }. */
export async function sendServerEvent(
  credentials: CapiCredentials,
  event: ServerEvent,
  fetchFn: typeof fetch = fetch,
): Promise<SendOutcome> {
  const body: Obj = { data: [event], access_token: credentials.access_token };
  if (credentials.test_event_code) body.test_event_code = credentials.test_event_code;

  let response: Response;
  try {
    response = await fetchFn(`${GRAPH_BASE_URL}/${credentials.pixel_id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    return {
      ok: false,
      kind: "transient",
      message: `Falha de rede com a Meta: ${String(cause)}`,
      code: null,
      subcode: null,
      response: null,
      needsUserAgent: false,
    };
  }

  const json = obj(await response.json().catch(() => null));
  const error = obj(json?.error);
  if (response.ok && json && !error) return { ok: true, response: json };

  const code = typeof error?.code === "number" ? error.code : null;
  const subcode = typeof error?.error_subcode === "number" ? error.error_subcode : null;
  const userMessage = typeof error?.error_user_msg === "string" ? error.error_user_msg : null;
  const message = [
    typeof error?.message === "string" ? error.message : `HTTP ${response.status}`,
    userMessage,
  ]
    .filter(Boolean)
    .join(" · ");
  let kind: CapiFailureKind = classifyMetaError(response.status, code, subcode);
  // Token, permissão e pixel inexistente (100/33) são da configuração, não do evento.
  if (kind === "token" || kind === "permission" || (code === 100 && subcode === 33))
    kind = "config";
  return {
    ok: false,
    kind,
    message: message.slice(0, 900),
    code,
    subcode,
    response: json,
    needsUserAgent: code === 100 && /user[\s_-]?agent/i.test(message),
  };
}

/** Segundos até a próxima tentativa (null = não tenta mais). */
export function retryDelaySeconds(kind: CapiFailureKind, attempts: number): number | null {
  if (kind === "config") return 60 * 60; // até alguém corrigir o token/pixel (salvar reagenda na hora)
  if (kind === "transient" || kind === "rate_limit") {
    const schedule = [60, 5 * 60, 30 * 60, 2 * 60 * 60, 6 * 60 * 60, 12 * 60 * 60];
    return attempts <= schedule.length ? schedule[attempts - 1]! : null;
  }
  return null; // parâmetro inválido: reenviar igual não adianta
}

/** Texto curto, em português, para o log e para o card. */
export function friendlyCapiError(outcome: Extract<SendOutcome, { ok: false }>): string {
  if (outcome.kind === "config") {
    if (outcome.code === 190 || outcome.code === 102)
      return `Token inválido ou expirado. Gere um novo no Gerenciador de Eventos. (${outcome.message})`;
    if (outcome.code === 100 && outcome.subcode === 33)
      return `Pixel não encontrado ou o token não tem acesso a ele. Confira o ID do pixel. (${outcome.message})`;
    return `O token não tem permissão neste pixel. (${outcome.message})`;
  }
  if (outcome.kind === "rate_limit")
    return `A Meta limitou as chamadas por um tempo. Tentaremos de novo. (${outcome.message})`;
  if (outcome.kind === "transient")
    return `A Meta não respondeu agora. Tentaremos de novo. (${outcome.message})`;
  return outcome.message;
}
