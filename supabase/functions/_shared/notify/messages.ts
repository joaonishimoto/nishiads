/** Textos das notificações (pt-BR). Sem dependência do Deno, para testar no Vitest. */

export type SaleNotificationKind = "sale_approved" | "sale_refunded" | "sale_chargeback" | "trial_started";

export interface SaleForMessage {
  id: string;
  workspace_id: string;
  gross_amount_cents: number;
  currency: string;
  product_name: string | null;
  campaign_name: string | null;
  ad_name: string | null;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  silent?: boolean;
  /** Botões da notificação (Chrome, Edge e Android; o iPhone ignora). */
  actions?: { action: string; title: string }[];
}

export function saleNotificationKind(status: string): SaleNotificationKind | null {
  if (status === "approved") return "sale_approved";
  if (status === "refunded") return "sale_refunded";
  if (status === "chargeback") return "sale_chargeback";
  if (status === "trialing") return "trial_started";
  return null;
}

export function formatMoney(cents: number, currency = "BRL"): string {
  // Intl separa "R$" do valor com espaço não separável; na notificação, espaço comum.
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency })
    .format(cents / 100)
    .replace(/ /g, " ");
}

const TITLES: Record<SaleNotificationKind, string> = {
  sale_approved: "💰 Venda aprovada",
  sale_refunded: "↩️ Reembolso",
  sale_chargeback: "⚠️ Chargeback",
  trial_started: "🧪 Teste iniciado",
};

export function salePushPayload(kind: SaleNotificationKind, sale: SaleForMessage): PushPayload {
  const origin = [sale.campaign_name, sale.ad_name].filter(Boolean).join(" › ") || "Sem origem identificada";
  const lines = [sale.product_name, origin].filter(Boolean);
  return {
    // Teste entra com valor zero: o título fica sem o valor.
    title: kind === "trial_started" ? TITLES[kind] : `${TITLES[kind]} · ${formatMoney(sale.gross_amount_cents, sale.currency)}`,
    body: lines.join("\n"),
    url: `/w/${sale.workspace_id}/vendas/${sale.id}`,
    tag: `${kind}:${sale.id}`,
  };
}

export interface RegistrationsByAd {
  campaign_name: string | null;
  ad_name: string | null;
  count: number;
}

/** Cadastros novos que a Meta atribuiu aos anúncios desde a última sincronização. */
export function registrationsPushPayload(workspaceId: string, ads: RegistrationsByAd[], at: string): PushPayload {
  const total = ads.reduce((n, a) => n + a.count, 0);
  const sorted = [...ads].sort((a, b) => b.count - a.count);
  const lines = sorted.slice(0, 3).map((a) => {
    const origin = [a.campaign_name, a.ad_name].filter(Boolean).join(" › ") || "Anúncio sem nome";
    return ads.length > 1 || a.count > 1 ? `${a.count}× ${origin}` : origin;
  });
  if (sorted.length > 3) lines.push(`e mais ${sorted.length - 3} anúncios`);
  return {
    title: total === 1 ? "📝 Novo cadastro" : `📝 ${total} novos cadastros`,
    body: lines.join("\n"),
    url: `/w/${workspaceId}/campanhas`,
    tag: `registrations:${workspaceId}:${at}`,
  };
}
