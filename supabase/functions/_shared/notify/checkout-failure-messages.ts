/** Push de checkout com falha (pt-BR). Função pura, testada em checkout-failure-messages.test.ts. */
import { formatMoney, type PushPayload } from "./messages.ts";

export type CheckoutFailureKind = "declined" | "expired" | "renewal_failed";

export interface CheckoutFailureForMessage {
  id: string;
  workspace_id: string;
  kind: CheckoutFailureKind;
  amount_cents: number;
  currency: string;
  product_name: string | null;
  reason_code: string | null;
  campaign_name: string | null;
  ad_name: string | null;
  utm_content: string | null;
}

/** Motivos de recusa mais comuns da Stripe, no idioma de quem lê o push. */
const REASONS: Record<string, string> = {
  insufficient_funds: "saldo insuficiente",
  generic_decline: "recusado pelo banco",
  do_not_honor: "recusado pelo banco",
  transaction_not_allowed: "o banco não autorizou esse tipo de compra",
  card_declined: "cartão recusado",
  expired_card: "cartão vencido",
  incorrect_number: "número do cartão errado",
  invalid_number: "número do cartão errado",
  incorrect_cvc: "código de segurança errado",
  invalid_cvc: "código de segurança errado",
  invalid_expiry_month: "validade errada",
  invalid_expiry_year: "validade errada",
  lost_card: "cartão bloqueado (perdido)",
  stolen_card: "cartão bloqueado (roubado)",
  pickup_card: "cartão bloqueado pelo banco",
  fraudulent: "barrado pelo antifraude",
  processing_error: "erro no processamento do cartão",
  authentication_required: "o banco pediu autenticação e ela não foi feita",
  setup_intent_authentication_failure: "falhou na autenticação do banco (3D Secure)",
  payment_intent_authentication_failure: "falhou na autenticação do banco (3D Secure)",
  card_not_supported: "cartão não aceita essa compra",
  currency_not_supported: "cartão não aceita a moeda",
  card_velocity_exceeded: "limite de tentativas do cartão",
  withdrawal_count_limit_exceeded: "limite do cartão excedido",
  payment_intent_payment_attempt_expired: "Pix ou boleto não pago a tempo",
};

export function declineReason(code: string | null): string | null {
  if (!code) return null;
  return REASONS[code] ?? code.replace(/_/g, " ");
}

function utmName(value: string | null): string | null {
  const name = value?.replace(/\|\s*\d+\s*$/, "").trim();
  return name && !/^\d+$/.test(name) ? name : null;
}

export function checkoutFailurePushPayload(f: CheckoutFailureForMessage): PushPayload {
  const origin =
    [f.campaign_name, f.ad_name].filter(Boolean).join(" › ") ||
    (utmName(f.utm_content) ? `${utmName(f.utm_content)} (anúncio ainda não sincronizado)` : null) ||
    "Sem anúncio identificado";
  const amount = f.amount_cents > 0 ? ` · ${formatMoney(f.amount_cents, f.currency)}` : "";
  const reason = declineReason(f.reason_code);

  let title: string;
  let what: string;
  if (f.kind === "declined") {
    title = `💳 Pagamento recusado${amount}`;
    what = `${reason ? capitalize(reason) : "Pagamento não aprovado"} e não tentou de novo`;
  } else if (f.kind === "expired") {
    title = `🛒 Checkout abandonado${amount}`;
    what = "Abriu o checkout e não concluiu";
  } else {
    title = `⚠️ Cobrança recusada${amount}`;
    what = `Fim do teste ou renovação${reason ? `: ${reason}` : ""}`;
  }
  return {
    title,
    body: [f.product_name ? `${f.product_name} · ${what}` : what, origin].join("\n"),
    url: `/w/${f.workspace_id}/vendas`,
    tag: `checkout_failure:${f.id}`,
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
