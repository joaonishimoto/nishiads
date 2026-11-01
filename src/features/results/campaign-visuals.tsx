import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { derived, type NodeMetrics, type TreeNode } from "@/features/results/metrics";
import { fmt, RoasBadge, Thumb } from "@/features/results/components";
import { DELIVERY_LABELS } from "@/features/results/campaign-tree";

export type CreativeItem = {
  node: TreeNode;
  campaign: string;
  adset: string;
  /** Campanha e conjunto do anúncio. */
  ancestors: TreeNode[];
};

/** Anúncios da árvore, com o caminho de cada um. */
export function flattenAds(tree: TreeNode[]): CreativeItem[] {
  return tree.flatMap((c) =>
    c.children.flatMap((s) =>
      s.children.map((a) => ({ node: a, campaign: c.name, adset: s.name, ancestors: [c, s] })),
    ),
  );
}

function ProfitText({
  m,
  currency,
  className,
}: {
  m: NodeMetrics;
  currency: string;
  className?: string;
}) {
  const p = derived.profit(m);
  return (
    <span
      className={cn(
        "font-semibold tabular-nums",
        p < 0 ? "text-danger-strong" : p > 0 ? "text-success-strong" : "text-muted-foreground",
        className,
      )}
    >
      {fmt.money(p, currency)}
    </span>
  );
}

/**
 * Campanhas lado a lado: faturamento contra gasto em barras na mesma escala, para ver
 * de relance quem paga o próprio gasto.
 */
export function CampaignRanking({
  nodes,
  currency,
  target,
  limit = 6,
  onOpenAll,
}: {
  nodes: TreeNode[];
  currency: string;
  target: number;
  limit?: number;
  onOpenAll?: () => void;
}) {
  const top = nodes.slice(0, limit);
  const max = Math.max(1, ...top.flatMap((n) => [n.metrics.spendCents, n.metrics.revenueCents]));
  const bar = (v: number) => `${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%`;
  return (
    <div>
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-3 text-xs text-muted-foreground"
        aria-hidden
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-chart-1" />
          Faturamento
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-chart-4" />
          Gasto
        </span>
      </div>
      <ul className="divide-y divide-border">
        {top.map((n) => (
          <li key={n.id} className="px-4 py-3">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  n.status === "ACTIVE" ? "bg-success" : "bg-border-strong",
                )}
                title={DELIVERY_LABELS[n.status ?? ""] ?? n.status ?? ""}
              />
              <p
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                title={n.name}
              >
                {n.name}
              </p>
              <RoasBadge roas={derived.roas(n.metrics)} target={target} />
            </div>
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 text-xs">
              <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-chart-1"
                  style={{ width: bar(n.metrics.revenueCents) }}
                />
              </div>
              <span className="w-24 text-right tabular-nums text-foreground">
                {fmt.money(n.metrics.revenueCents, currency)}
              </span>
              <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-chart-4"
                  style={{ width: bar(n.metrics.spendCents) }}
                />
              </div>
              <span className="w-24 text-right tabular-nums text-muted-foreground">
                {fmt.money(n.metrics.spendCents, currency)}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {n.metrics.sales === 1 ? "1 venda" : `${fmt.int(n.metrics.sales)} vendas`} · CPA{" "}
              {fmt.money(derived.cpa(n.metrics), currency)} · lucro{" "}
              <ProfitText m={n.metrics} currency={currency} className="font-medium" />
            </p>
          </li>
        ))}
      </ul>
      {onOpenAll && nodes.length > 0 && (
        <button
          type="button"
          onClick={onOpenAll}
          className="flex w-full items-center justify-center gap-1 border-t border-border px-4 py-2.5 text-xs font-medium text-primary hover:bg-surface-hover"
        >
          {nodes.length > limit
            ? `Ver as ${nodes.length} campanhas na tabela`
            : "Abrir a tabela completa"}
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** Lista curta dos anúncios que mais deram lucro, com miniatura. */
export function TopCreatives({
  items,
  currency,
  target,
  onOpenAll,
}: {
  items: CreativeItem[];
  currency: string;
  target: number;
  onOpenAll?: () => void;
}) {
  const top = [...items]
    .sort((a, b) => derived.profit(b.node.metrics) - derived.profit(a.node.metrics))
    .slice(0, 5);
  if (top.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-muted-foreground">
        Nenhum anúncio com gasto no período.
      </p>
    );
  }
  return (
    <div>
      <ol className="divide-y divide-border">
        {top.map((it) => (
          <li key={it.node.id} className="flex items-center gap-3 px-4 py-2.5">
            <Thumb src={it.node.thumbnailUrl} alt="" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{it.node.name}</p>
              <p className="truncate text-xs text-muted-foreground">{it.campaign}</p>
            </div>
            <div className="shrink-0 text-right">
              <RoasBadge roas={derived.roas(it.node.metrics)} target={target} />
              <p className="mt-0.5 text-xs">
                <ProfitText m={it.node.metrics} currency={currency} className="font-medium" />
              </p>
            </div>
          </li>
        ))}
      </ol>
      {onOpenAll && (
        <button
          type="button"
          onClick={onOpenAll}
          className="flex w-full items-center justify-center gap-1 border-t border-border px-4 py-2.5 text-xs font-medium text-primary hover:bg-surface-hover"
        >
          Ver todos os {fmt.int(items.length)} criativos
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
