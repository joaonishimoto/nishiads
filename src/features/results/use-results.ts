import { useMemo } from "react";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { useAdAccounts } from "@/features/meta/api";
import { useAdStructure, useInsights, useProducts, useResultSales } from "@/features/results/data";
import {
  buildTree,
  computeTotals,
  dailySeries,
  filterInsights,
  filterSales,
  type ProductCost,
} from "@/features/results/metrics";
import type { ResultFiltersState } from "@/features/results/filters";

/**
 * Tudo que Vendas e Campanhas precisam para o recorte atual: vendas e insights do período
 * e do período anterior (comparação), estrutura da Meta e custos dos produtos.
 */
export function useResults(filters: ResultFiltersState, { tree = false }: { tree?: boolean } = {}) {
  const { workspace } = useWorkspace();
  const accounts = useAdAccounts(workspace.id);
  const tracked = useMemo(() => (accounts.data ?? []).filter((a) => a.is_tracked), [accounts.data]);
  const metaConnected = tracked.length > 0;
  // A última sincronização entra na chave dos insights: dados novos aparecem sozinhos.
  const lastSync =
    tracked
      .map((a) => a.last_synced_at)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1) ?? null;

  const products = useProducts(workspace.id);
  const sales = useResultSales(workspace.id, filters.range);
  const prevSales = useResultSales(workspace.id, filters.previous.range);
  const insights = useInsights(workspace.id, filters.days, lastSync, metaConnected);
  const prevInsights = useInsights(workspace.id, filters.previous.days, lastSync, metaConnected);
  const structure = useAdStructure(workspace.id, lastSync, metaConnected && tree);

  const productMap = useMemo(
    () => new Map<string, ProductCost>((products.data ?? []).map((p) => [p.id, p])),
    [products.data],
  );
  const scope = { accountId: filters.accountId, productId: filters.productId };

  const computed = useMemo(() => {
    if (!sales.data) return null;
    const s = filterSales(sales.data, scope);
    const ins = filterInsights(insights.data ?? [], scope);
    const ps = prevSales.data ? filterSales(prevSales.data, scope) : null;
    const pins = filterInsights(prevInsights.data ?? [], scope);
    return {
      sales: s,
      totals: computeTotals(s, ins, productMap, workspace.currency),
      previous: ps ? computeTotals(ps, pins, productMap, workspace.currency) : null,
      series: dailySeries(s, ins, filters.days, workspace.timezone, workspace.currency),
      tree:
        tree && structure.data
          ? buildTree(structure.data, s, ins, productMap, workspace.currency, filters.accountId)
          : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sales.data,
    prevSales.data,
    insights.data,
    prevInsights.data,
    structure.data,
    productMap,
    filters.accountId,
    filters.productId,
    filters.days,
    workspace.currency,
    workspace.timezone,
    tree,
  ]);

  const pending =
    accounts.isPending ||
    sales.isPending ||
    products.isPending ||
    (metaConnected && insights.isPending) ||
    (metaConnected && tree && structure.isPending);
  const failed = [
    accounts,
    sales,
    products,
    ...(metaConnected ? [insights, ...(tree ? [structure] : [])] : []),
  ].filter((q) => q.isError);

  return {
    accounts: accounts.data ?? [],
    tracked,
    metaConnected,
    lastSync,
    products: products.data ?? [],
    productMap,
    allSales: sales.data ?? [],
    computed,
    isPending: pending,
    isError: failed.length > 0,
    isFetching: failed.some((q) => q.isFetching),
    retry: () => failed.forEach((q) => q.refetch()),
  };
}
