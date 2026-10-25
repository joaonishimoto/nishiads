import { useEffect, useRef } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { formatMoney } from "@/lib/format";
import type { DateRange } from "@/lib/period";
import type { AttributionStatus, SaleStatus, Tables } from "@/types/database";

const PAGE_SIZE = 50;

export type SalesFilters = {
  range: DateRange;
  status: SaleStatus | "all";
  /** "unmatched" = visão "Vendas sem origem" (parcial + sem origem). */
  attribution: "all" | "unmatched";
};

const SALE_LIST_COLUMNS =
  "id, provider, external_order_id, status, gross_amount_cents, net_amount_cents, currency, product_name, " +
  "utm_source, utm_medium, utm_campaign, utm_content, utm_term, attribution_status, paid_at, created_at, " +
  "campaign:campaigns(id, name), adset:adsets(id, name), ad:ads(id, name, thumbnail_url)";

export type SaleListItem = Pick<
  Tables<"sales">,
  | "id"
  | "provider"
  | "external_order_id"
  | "status"
  | "gross_amount_cents"
  | "net_amount_cents"
  | "currency"
  | "product_name"
  | "utm_source"
  | "utm_medium"
  | "utm_campaign"
  | "utm_content"
  | "utm_term"
  | "attribution_status"
  | "paid_at"
  | "created_at"
> & {
  campaign: { id: string; name: string } | null;
  adset: { id: string; name: string } | null;
  ad: { id: string; name: string; thumbnail_url: string | null } | null;
};

export const salesKeys = {
  all: (workspaceId: string) => ["sales", workspaceId] as const,
  list: (workspaceId: string, filters: SalesFilters) => ["sales", workspaceId, "list", filters] as const,
  summary: (workspaceId: string, range: DateRange) => ["sales", workspaceId, "summary", range] as const,
  detail: (workspaceId: string, saleId: string) => ["sales", workspaceId, "detail", saleId] as const,
};

/**
 * Data de referência da venda: paid_at quando houver; pendentes e recusadas usam created_at.
 * O filtro de período usa a mesma regra.
 */
function applyRange<Q extends { or: (filter: string) => Q }>(query: Q, range: DateRange): Q {
  return query.or(
    `and(paid_at.gte.${range.from},paid_at.lt.${range.to}),` +
      `and(paid_at.is.null,created_at.gte.${range.from},created_at.lt.${range.to})`,
  );
}

export function useSalesList(workspaceId: string, filters: SalesFilters) {
  return useInfiniteQuery({
    queryKey: salesKeys.list(workspaceId, filters),
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<SaleListItem[]> => {
      let query = supabase.from("sales").select(SALE_LIST_COLUMNS).eq("workspace_id", workspaceId);
      query = applyRange(query, filters.range);
      if (filters.status !== "all") query = query.eq("status", filters.status);
      if (filters.attribution === "unmatched") query = query.neq("attribution_status", "matched");
      const { data, error } = await query
        .order("paid_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .order("id")
        .range(pageParam * PAGE_SIZE, pageParam * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) throw error;
      return (data ?? []) as unknown as SaleListItem[];
    },
    getNextPageParam: (last, pages) => (last.length === PAGE_SIZE ? pages.length : undefined),
  });
}

export type SalesSummary = {
  approvedCount: number;
  approvedRevenueCents: number;
  refundCount: number;
  matchedShare: number | null;
  unmatchedCount: number;
};

type SummaryRow = { status: SaleStatus; gross_amount_cents: number; attribution_status: AttributionStatus; currency: string };

/** KPIs do período. Lê só colunas leves, em páginas de 1000 (limite do PostgREST). */
export function useSalesSummary(workspaceId: string, range: DateRange, currency: string) {
  return useQuery({
    queryKey: salesKeys.summary(workspaceId, range),
    queryFn: async (): Promise<SalesSummary> => {
      const rows: SummaryRow[] = [];
      for (let page = 0; ; page++) {
        let query = supabase
          .from("sales")
          .select("status, gross_amount_cents, attribution_status, currency")
          .eq("workspace_id", workspaceId);
        query = applyRange(query, range);
        const { data, error } = await query.order("id").range(page * 1000, page * 1000 + 999);
        if (error) throw error;
        rows.push(...((data ?? []) as SummaryRow[]));
        if (!data || data.length < 1000) break;
      }
      const approved = rows.filter((r) => r.status === "approved");
      const matched = approved.filter((r) => r.attribution_status === "matched").length;
      return {
        approvedCount: approved.length,
        // Só soma a moeda do workspace: nunca mistura moedas.
        approvedRevenueCents: approved
          .filter((r) => r.currency === currency)
          .reduce((sum, r) => sum + r.gross_amount_cents, 0),
        refundCount: rows.filter((r) => r.status === "refunded" || r.status === "chargeback").length,
        matchedShare: approved.length ? matched / approved.length : null,
        unmatchedCount: rows.filter((r) => r.attribution_status !== "matched").length,
      };
    },
  });
}

export type SaleDetail = Tables<"sales"> & {
  campaign: { id: string; name: string; external_id: string } | null;
  adset: { id: string; name: string; external_id: string } | null;
  ad: { id: string; name: string; external_id: string; thumbnail_url: string | null; preview_link: string | null } | null;
  integration: { id: string; name: string } | null;
};

export function useSale(workspaceId: string, saleId: string) {
  return useQuery({
    queryKey: salesKeys.detail(workspaceId, saleId),
    queryFn: async (): Promise<SaleDetail | null> => {
      const { data, error } = await supabase
        .from("sales")
        .select(
          "*, campaign:campaigns(id, name, external_id), adset:adsets(id, name, external_id), " +
            "ad:ads(id, name, external_id, thumbnail_url, preview_link), integration:checkout_integrations(id, name)",
        )
        .eq("workspace_id", workspaceId)
        .eq("id", saleId)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as SaleDetail | null;
    },
  });
}

export function useReattributeSales(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("reattribute_sales", { p_workspace_id: workspaceId });
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: salesKeys.all(workspaceId) }),
  });
}

type RealtimeSale = Pick<Tables<"sales">, "id" | "status" | "gross_amount_cents" | "currency" | "paid_at" | "product_name">;

/**
 * Supabase Realtime: atualiza as listas e mostra um toast quando uma venda é aprovada
 * com a tela aberta. O RLS do Realtime garante que só chegam vendas do workspace.
 */
export function useSalesRealtime(workspaceId: string, options: { onApproved?: (sale: RealtimeSale) => void } = {}) {
  const qc = useQueryClient();
  const announced = useRef(new Set<string>());
  const onApproved = useRef(options.onApproved);
  onApproved.current = options.onApproved;

  useEffect(() => {
    const channel = supabase
      .channel(`sales:${workspaceId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sales", filter: `workspace_id=eq.${workspaceId}` },
        (payload) => {
          qc.invalidateQueries({ queryKey: salesKeys.all(workspaceId) });
          const sale = payload.new as Partial<RealtimeSale>;
          if (!sale?.id || sale.status !== "approved" || announced.current.has(sale.id)) return;
          // Só vendas aprovadas agora (reatribuições de vendas antigas não tocam o alerta).
          const paidAt = sale.paid_at ? new Date(sale.paid_at).getTime() : Date.now();
          if (Date.now() - paidAt > 15 * 60_000) return;
          announced.current.add(sale.id);
          const full = sale as RealtimeSale;
          toast.success(`💰 Venda aprovada: ${formatMoney(full.gross_amount_cents, full.currency)}`, {
            description: full.product_name ?? undefined,
          });
          onApproved.current?.(full);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc, workspaceId]);
}
