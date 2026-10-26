import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { formatMoney } from "@/lib/format";
import type { Tables } from "@/types/database";

export const salesKeys = {
  all: (workspaceId: string) => ["sales", workspaceId] as const,
  detail: (workspaceId: string, saleId: string) => ["sales", workspaceId, "detail", saleId] as const,
};

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
