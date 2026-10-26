import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { DateRange } from "@/lib/period";
import type { AdStructure, InsightRow, ProductCost, ResultSale } from "@/features/results/metrics";

const PAGE = 1000;

/** Lê todas as páginas (o PostgREST devolve no máximo 1000 linhas por vez). */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; ; i++) {
    const { data, error } = await page(i * PAGE, i * PAGE + PAGE - 1);
    if (error) throw error;
    const chunk = (data ?? []) as T[];
    rows.push(...chunk);
    if (chunk.length < PAGE) return rows;
  }
}

const SALE_COLUMNS =
  "id, provider, external_order_id, status, gross_amount_cents, net_amount_cents, currency, product_id, product_name, " +
  "utm_source, utm_medium, utm_campaign, utm_content, utm_term, attribution_status, campaign_id, adset_id, ad_id, " +
  "paid_at, created_at, trial_converted_at, " +
  "campaign:campaigns(id, name, ad_account_id), adset:adsets(id, name), ad:ads(id, name, thumbnail_url)";

/**
 * Vendas do período, mais recentes primeiro. A chave fica sob ["sales", workspace]: o
 * Realtime de vendas invalida tudo de uma vez.
 */
export function useResultSales(workspaceId: string, range: DateRange, enabled = true) {
  return useQuery({
    queryKey: ["sales", workspaceId, "results", range],
    enabled,
    placeholderData: (previous) => previous,
    queryFn: () =>
      fetchAll<ResultSale>((from, to) =>
        supabase
          .from("sales")
          .select(SALE_COLUMNS)
          .eq("workspace_id", workspaceId)
          // Pagamento quando houver; pendentes, recusadas e testes usam a criação.
          .or(
            `and(paid_at.gte.${range.from},paid_at.lt.${range.to}),` +
              `and(paid_at.is.null,created_at.gte.${range.from},created_at.lt.${range.to})`,
          )
          .order("paid_at", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false })
          .order("id")
          .range(from, to),
      ),
  });
}

/** Insights diários dos anúncios entre dois dias (inclusive). `version` muda a cada sincronização. */
export function useInsights(
  workspaceId: string,
  days: { first: string; last: string },
  version: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["meta", workspaceId, "insights", days, version],
    enabled,
    placeholderData: (previous) => previous,
    queryFn: () =>
      fetchAll<InsightRow>((from, to) =>
        supabase
          .from("ad_insights_daily")
          .select(
            "ad_id, date, ad_account_id, currency, spend_cents, impressions, clicks, link_clicks",
          )
          .eq("workspace_id", workspaceId)
          .gte("date", days.first)
          .lte("date", days.last)
          .order("ad_id")
          .order("date")
          .range(from, to),
      ),
  });
}

/** Campanhas, conjuntos e anúncios sincronizados da Meta. */
export function useAdStructure(workspaceId: string, version: string | null, enabled = true) {
  return useQuery({
    queryKey: ["meta", workspaceId, "structure", version],
    enabled,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<AdStructure> => {
      const [campaigns, adsets, ads] = await Promise.all([
        fetchAll<AdStructure["campaigns"][number]>((from, to) =>
          supabase
            .from("campaigns")
            .select("id, name, ad_account_id, effective_status")
            .eq("workspace_id", workspaceId)
            .order("id")
            .range(from, to),
        ),
        fetchAll<AdStructure["adsets"][number]>((from, to) =>
          supabase
            .from("adsets")
            .select("id, name, ad_account_id, campaign_id, effective_status")
            .eq("workspace_id", workspaceId)
            .order("id")
            .range(from, to),
        ),
        fetchAll<AdStructure["ads"][number]>((from, to) =>
          supabase
            .from("ads")
            .select(
              "id, name, ad_account_id, campaign_id, adset_id, effective_status, thumbnail_url, preview_link",
            )
            .eq("workspace_id", workspaceId)
            .order("id")
            .range(from, to),
        ),
      ]);
      return { campaigns, adsets, ads };
    },
  });
}

export const productKeys = { all: (workspaceId: string) => ["products", workspaceId] as const };

export function useProducts(workspaceId: string) {
  return useQuery({
    queryKey: productKeys.all(workspaceId),
    queryFn: async (): Promise<ProductCost[]> => {
      const { data, error } = await supabase
        .from("products")
        .select("id, name, cost_cents, fee_percent_bps, fee_fixed_cents")
        .eq("workspace_id", workspaceId)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useUpdateProductCost(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      product: Pick<ProductCost, "id" | "cost_cents" | "fee_percent_bps" | "fee_fixed_cents">,
    ) => {
      const { id, ...values } = product;
      const { error } = await supabase
        .from("products")
        .update(values)
        .eq("id", id)
        .eq("workspace_id", workspaceId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: productKeys.all(workspaceId) }),
  });
}
