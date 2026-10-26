import { useMemo, useState } from "react";
import { ChevronRight, ExternalLink, TrendingDown, TrendingUp } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { derived, type NodeMetrics, type TreeNode } from "@/features/results/metrics";
import { fmt, RoasBadge, Thumb } from "@/features/results/components";
import { DELIVERY_LABELS } from "@/features/results/campaign-tree";
import { DeliveryToggle } from "@/features/meta/controls";

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

type CreativeSort = "profit" | "roas" | "revenue" | "spend" | "sales";
const SORTS: { key: CreativeSort; label: string; value: (m: NodeMetrics) => number | null }[] = [
  { key: "profit", label: "Maior lucro", value: derived.profit },
  { key: "roas", label: "Maior ROAS", value: derived.roas },
  { key: "revenue", label: "Maior faturamento", value: (m) => m.revenueCents },
  { key: "spend", label: "Maior gasto", value: (m) => m.spendCents },
  { key: "sales", label: "Mais vendas", value: (m) => m.sales },
];

type CreativeFilter = "all" | "profit" | "loss" | "nosale";
const FILTERS: { key: CreativeFilter; label: string; match: (m: NodeMetrics) => boolean }[] = [
  { key: "all", label: "Todos", match: () => true },
  { key: "profit", label: "Dando lucro", match: (m) => derived.profit(m) > 0 },
  { key: "loss", label: "No prejuízo", match: (m) => derived.profit(m) < 0 },
  { key: "nosale", label: "Sem venda", match: (m) => m.sales === 0 && m.spendCents > 0 },
];

/** Cada anúncio como um cartão: criativo, caminho e as métricas que decidem pausar ou escalar. */
export function CreativeGrid({
  items,
  currency,
  target,
}: {
  items: CreativeItem[];
  currency: string;
  target: number;
}) {
  const [sort, setSort] = useState<CreativeSort>("profit");
  const [filter, setFilter] = useState<CreativeFilter>("all");
  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((f) => [f.key, items.filter((i) => f.match(i.node.metrics)).length]),
      ),
    [items],
  );
  const shown = useMemo(() => {
    const by = SORTS.find((s) => s.key === sort)!.value;
    const match = FILTERS.find((f) => f.key === filter)!.match;
    return items
      .filter((i) => match(i.node.metrics))
      .sort((a, b) => {
        const va = by(a.node.metrics);
        const vb = by(b.node.metrics);
        if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
        return vb - va;
      });
  }, [items, sort, filter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
          role="group"
          aria-label="Filtrar criativos"
        >
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                filter === f.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-surface text-muted-foreground hover:border-border-strong hover:text-foreground",
              )}
            >
              {f.label}
              <span className="tabular-nums opacity-80">{fmt.int(counts[f.key] ?? 0)}</span>
            </button>
          ))}
        </div>
        <Select value={sort} onValueChange={(v) => setSort(v as CreativeSort)}>
          <SelectTrigger aria-label="Ordenar criativos" className="h-8 w-auto gap-1.5 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong px-4 py-10 text-center text-sm text-muted-foreground">
          Nenhum criativo nesse filtro.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((it) => (
            <CreativeCard key={it.node.id} item={it} currency={currency} target={target} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CreativeCard({
  item,
  currency,
  target,
}: {
  item: CreativeItem;
  currency: string;
  target: number;
}) {
  const m = item.node.metrics;
  const profit = derived.profit(m);
  const roas = derived.roas(m);
  const active = item.node.status === "ACTIVE";
  return (
    <li
      className={cn(
        "flex flex-col rounded-lg border bg-surface p-3 sm:p-4",
        profit < 0 ? "border-danger/25" : profit > 0 ? "border-success/25" : "border-border",
      )}
    >
      <div className="flex gap-3">
        <span className="relative shrink-0">
          <Thumb src={item.node.thumbnailUrl} alt="" size="lg" />
          <span
            className={cn(
              "absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-surface",
              active ? "bg-success" : "bg-border-strong",
            )}
            title={DELIVERY_LABELS[item.node.status ?? ""] ?? item.node.status ?? ""}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p
              className="line-clamp-2 text-sm font-medium leading-5 text-foreground"
              title={item.node.name}
            >
              {item.node.name}
            </p>
            <DeliveryToggle node={item.node} ancestors={item.ancestors} />
          </div>
          <p
            className="mt-0.5 truncate text-xs text-muted-foreground"
            title={`${item.campaign} › ${item.adset}`}
          >
            {item.campaign} › {item.adset}
          </p>
          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            {DELIVERY_LABELS[item.node.status ?? ""] ?? item.node.status ?? "Sem status"}
            {item.node.previewLink && (
              <a
                href={item.node.previewLink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
              >
                ver anúncio
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between gap-3 rounded-md bg-surface-muted px-3 py-2">
        <div>
          <p className="text-[11px] text-muted-foreground">Lucro</p>
          <p
            className={cn(
              "inline-flex items-center gap-1 text-lg font-semibold tabular-nums",
              profit < 0
                ? "text-danger-strong"
                : profit > 0
                  ? "text-success-strong"
                  : "text-foreground",
            )}
          >
            {profit > 0 ? (
              <TrendingUp className="h-4 w-4" />
            ) : profit < 0 ? (
              <TrendingDown className="h-4 w-4" />
            ) : null}
            {fmt.money(profit, currency)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[11px] text-muted-foreground">ROAS</p>
          <RoasBadge roas={roas} target={target} className="text-base" />
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2 text-xs">
        <Cell label="Gasto" value={fmt.money(m.spendCents, currency)} />
        <Cell label="Faturamento" value={fmt.money(m.revenueCents, currency)} />
        <Cell label="Vendas" value={fmt.int(m.sales)} />
        <Cell label="CPA" value={fmt.money(derived.cpa(m), currency)} />
        <Cell label="CTR" value={fmt.pct(derived.ctr(m), 2)} />
        <Cell label="CPC" value={fmt.money(derived.cpc(m), currency)} />
      </dl>
    </li>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums text-foreground [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}
