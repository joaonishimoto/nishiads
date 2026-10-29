/**
 * Ações que a Meta conta por anúncio (campo actions dos insights) e que viram colunas
 * opcionais em Campanhas. A sincronização guarda todas as que vierem; aqui fica só como
 * mostrar cada uma.
 */

export type MetaActionMetric = {
  key: string;
  label: string;
  hint: string;
  /**
   * A Meta repete o mesmo evento em vários action_type (omni_, total, só site, só pixel).
   * Vale o primeiro que existir, nesta ordem, para não contar duas vezes.
   */
  types: string[];
  /** Também oferece a coluna "custo por". */
  cost?: { label: string; hint: string };
};

export const META_ACTION_METRICS: MetaActionMetric[] = [
  {
    key: "landing_page_views",
    label: "Visualizações da página",
    hint: "páginas carregadas depois do clique no anúncio",
    types: ["omni_landing_page_view", "landing_page_view"],
    cost: { label: "Custo por visualização da página", hint: "gasto ÷ visualizações da página" },
  },
  {
    key: "view_content",
    label: "Visualizações de conteúdo",
    hint: "evento ViewContent do pixel",
    types: ["omni_view_content", "view_content", "offsite_conversion.fb_pixel_view_content"],
  },
  {
    key: "leads",
    label: "Leads",
    hint: "evento Lead do pixel ou formulário da Meta",
    types: ["lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped"],
    cost: { label: "Custo por lead", hint: "gasto ÷ leads" },
  },
  {
    key: "add_to_cart",
    label: "Adições ao carrinho",
    hint: "evento AddToCart do pixel",
    types: ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"],
  },
  {
    key: "initiate_checkout",
    label: "Inícios de checkout",
    hint: "evento InitiateCheckout do pixel",
    types: [
      "omni_initiated_checkout",
      "initiate_checkout",
      "offsite_conversion.fb_pixel_initiate_checkout",
    ],
    cost: { label: "Custo por início de checkout", hint: "gasto ÷ inícios de checkout" },
  },
  {
    key: "add_payment_info",
    label: "Pagamentos adicionados",
    hint: "evento AddPaymentInfo do pixel",
    types: ["add_payment_info", "offsite_conversion.fb_pixel_add_payment_info"],
  },
  {
    key: "subscribe",
    label: "Assinaturas (Meta)",
    hint: "evento Subscribe do pixel",
    types: ["subscribe_total", "subscribe_website", "offsite_conversion.fb_pixel_subscribe"],
  },
  {
    key: "meta_purchases",
    label: "Compras (Meta)",
    hint: "compras que a Meta atribuiu; podem diferir das vendas do checkout",
    types: ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"],
  },
  {
    key: "messaging",
    label: "Conversas iniciadas",
    hint: "conversas por mensagem iniciadas pelo anúncio",
    types: ["onsite_conversion.messaging_conversation_started_7d"],
    cost: { label: "Custo por conversa", hint: "gasto ÷ conversas iniciadas" },
  },
  {
    key: "video_views",
    label: "Visualizações do vídeo",
    hint: "vídeo assistido por 3 segundos ou mais",
    types: ["video_view"],
    cost: { label: "Custo por visualização do vídeo", hint: "gasto ÷ visualizações de 3 s" },
  },
  {
    key: "engagement",
    label: "Engajamento",
    hint: "todas as interações com o anúncio",
    types: ["post_engagement"],
  },
  {
    key: "reactions",
    label: "Reações",
    hint: "curtidas e outras reações",
    types: ["post_reaction"],
  },
  { key: "comments", label: "Comentários", hint: "comentários no anúncio", types: ["comment"] },
  {
    key: "shares",
    label: "Compartilhamentos",
    hint: "vezes que o anúncio foi compartilhado",
    types: ["post"],
  },
  {
    key: "saves",
    label: "Salvamentos",
    hint: "vezes que o anúncio foi salvo",
    types: ["onsite_conversion.post_save"],
  },
  {
    key: "page_likes",
    label: "Curtidas na página",
    hint: "curtidas na página vindas do anúncio",
    types: ["like"],
  },
];

/** Contagem de uma métrica nas ações somadas (primeiro action_type que existir). */
export function actionValue(actions: Record<string, number>, types: string[]): number {
  for (const type of types) {
    const value = actions[type];
    if (value !== undefined) return value;
  }
  return 0;
}

/** Soma as ações de `from` em `into`. */
export function addActions(
  into: Record<string, number>,
  from: Record<string, number> | null | undefined,
) {
  if (!from) return;
  for (const [type, value] of Object.entries(from)) {
    if (typeof value === "number" && Number.isFinite(value)) into[type] = (into[type] ?? 0) + value;
  }
}
