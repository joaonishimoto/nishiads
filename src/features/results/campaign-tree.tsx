import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ExternalLink,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { derived, type Level, type NodeMetrics, type TreeNode } from "@/features/results/metrics";
import { fmt, RoasBadge, Thumb } from "@/features/results/components";
import { BudgetValue, DeliveryToggle, useMetaControls } from "@/features/meta/controls";
import type { ViewCatalog } from "@/features/views/catalog";

export const DELIVERY_LABELS: Record<string, string> = {
  ACTIVE: "Ativo",
  PAUSED: "Pausado",
  CAMPAIGN_PAUSED: "Campanha pausada",
  ADSET_PAUSED: "Conjunto pausado",
  ARCHIVED: "Arquivado",
  DELETED: "Excluído",
  IN_PROCESS: "Em processamento",
  WITH_ISSUES: "Com problemas",
  DISAPPROVED: "Reprovado",
  PENDING_REVIEW: "Em análise",
};

const LEVEL_LABELS: Record<Level, string> = {
  campaign: "Campanha",
  adset: "Conjunto",
  ad: "Anúncio",
};

type ColumnKey =
  | "spend"
  | "impressions"
  | "clicks"
  | "ctr"
  | "cpc"
  | "sales"
  | "revenue"
  | "roas"
  | "cpa"
  | "profit"
  | "cpm"
  | "ticket"
  | "conversion"
  | "registrations"
  | "cpl"
  | "trials";

function cpm(m: NodeMetrics) {
  return m.impressions > 0 ? Math.round((m.spendCents / m.impressions) * 1000) : null;
}
function ticket(m: NodeMetrics) {
  return m.sales > 0 ? Math.round(m.revenueCents / m.sales) : null;
}
/** Custo por cadastro. */
function cpl(m: NodeMetrics) {
  return m.registrations > 0 && m.spendCents > 0 ? Math.round(m.spendCents / m.registrations) : null;
}
/** Vendas por clique no link. */
function conversion(m: NodeMetrics) {
  return m.linkClicks > 0 ? m.sales / m.linkClicks : null;
}

const COLUMN_HINTS: Partial<Record<ColumnKey, string>> = {
  cpm: "custo por mil impressões",
  conversion: "vendas por clique",
  registrations: "CompleteRegistration, atribuído pela Meta",
  trials: "StartTrial, atribuído pela Meta",
};

type Column = {
  key: ColumnKey;
  label: string;
  value: (m: NodeMetrics) => number | null;
  render: (m: NodeMetrics, ctx: { currency: string; target: number }) => ReactNode;
};

const COLUMNS: Column[] = [
  {
    key: "spend",
    label: "Gasto",
    value: (m) => m.spendCents,
    render: (m, c) => fmt.money(m.spendCents, c.currency),
  },
  {
    key: "registrations",
    label: "Cadastros",
    value: (m) => m.registrations,
    render: (m) => fmt.int(m.registrations),
  },
  {
    key: "cpl",
    label: "Custo por cadastro",
    value: cpl,
    render: (m, c) => fmt.money(cpl(m), c.currency),
  },
  { key: "trials", label: "Testes", value: (m) => m.trials, render: (m) => fmt.int(m.trials) },
  { key: "sales", label: "Vendas", value: (m) => m.sales, render: (m) => fmt.int(m.sales) },
  {
    key: "revenue",
    label: "Faturamento",
    value: (m) => m.revenueCents,
    render: (m, c) => fmt.money(m.revenueCents, c.currency),
  },
  {
    key: "roas",
    label: "ROAS",
    value: derived.roas,
    render: (m, c) => <RoasBadge roas={derived.roas(m)} target={c.target} />,
  },
  {
    key: "cpa",
    label: "CPA",
    value: derived.cpa,
    render: (m, c) => fmt.money(derived.cpa(m), c.currency),
  },
  {
    key: "profit",
    label: "Lucro",
    value: derived.profit,
    render: (m, c) => {
      const p = derived.profit(m);
      return (
        <span
          className={cn(
            "font-medium",
            p < 0 ? "text-danger-strong" : p > 0 ? "text-success-strong" : "text-muted-foreground",
          )}
        >
          {fmt.money(p, c.currency)}
        </span>
      );
    },
  },
  {
    key: "impressions",
    label: "Impressões",
    value: (m) => m.impressions,
    render: (m) => fmt.int(m.impressions),
  },
  {
    key: "clicks",
    label: "Cliques",
    value: (m) => m.linkClicks,
    render: (m) => fmt.int(m.linkClicks),
  },
  { key: "ctr", label: "CTR", value: derived.ctr, render: (m) => fmt.pct(derived.ctr(m), 2) },
  {
    key: "cpc",
    label: "CPC",
    value: derived.cpc,
    render: (m, c) => fmt.money(derived.cpc(m), c.currency),
  },
  {
    key: "cpm",
    label: "CPM",
    value: cpm,
    render: (m, c) => fmt.money(cpm(m), c.currency),
  },
  {
    key: "ticket",
    label: "Ticket médio",
    value: ticket,
    render: (m, c) => fmt.money(ticket(m), c.currency),
  },
  {
    key: "conversion",
    label: "Conversão",
    value: conversion,
    render: (m) => fmt.pct(conversion(m), 2),
  },
];

/** Colunas que dá para ligar e desligar no template de Campanhas, além do orçamento. */
const DEFAULT_COLUMNS: ColumnKey[] = [
  "spend",
  "registrations",
  "cpl",
  "trials",
  "sales",
  "revenue",
  "roas",
  "cpa",
  "profit",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
];

export const CAMPAIGNS_VIEW: ViewCatalog = {
  groups: [{ key: "columns", label: "Colunas", reorder: true }],
  options: [
    { key: "budget", label: "Orçamento", group: "columns", hint: "quando a Meta informa" },
    ...COLUMNS.map((c) => ({
      key: c.key,
      label: c.label,
      group: "columns",
      hint: COLUMN_HINTS[c.key],
    })),
  ],
  defaults: ["budget", ...DEFAULT_COLUMNS],
};

type Sort = { key: ColumnKey; dir: "asc" | "desc" };

function sortNodes(nodes: TreeNode[], sort: Sort): TreeNode[] {
  const col = COLUMNS.find((c) => c.key === sort.key)!;
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...nodes]
    .sort((a, b) => {
      const va = col.value(a.metrics);
      const vb = col.value(b.metrics);
      // Sem valor (ROAS sem gasto, CPA sem venda) fica no fim nas duas direções.
      if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
      return sign * (va - vb);
    })
    .map((n) => ({ ...n, children: sortNodes(n.children, sort) }));
}

function matches(node: TreeNode, q: string): boolean {
  return node.name.toLowerCase().includes(q) || node.children.some((c) => matches(c, q));
}

function prune(nodes: TreeNode[], q: string): TreeNode[] {
  if (!q) return nodes;
  return nodes
    .filter((n) => matches(n, q))
    .map((n) => (n.name.toLowerCase().includes(q) ? n : { ...n, children: prune(n.children, q) }));
}

function StatusDot({ status }: { status: string | null }) {
  const active = status === "ACTIVE";
  const label = DELIVERY_LABELS[status ?? ""] ?? status ?? "Sem status";
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        active ? "bg-success" : "bg-border-strong",
      )}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

export function CampaignTree({
  nodes,
  totals,
  currency,
  target,
  toolbar,
  unattributed,
  columns,
}: {
  nodes: TreeNode[];
  totals: NodeMetrics;
  currency: string;
  target: number;
  toolbar?: ReactNode;
  /** Vendas aprovadas sem campanha: linha de rodapé com link para a visão Sem origem. */
  unattributed?: { sales: number; revenueCents: number; to: string };
  /** Colunas do template, na ordem (CAMPAIGNS_VIEW); sem template, as de sempre. */
  columns?: readonly string[];
}) {
  const [sort, setSort] = useState<Sort>({ key: "spend", dir: "desc" });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => prune(sortNodes(nodes, sort), q), [nodes, sort, q]);
  const ctx = { currency, target };
  const keys = columns ?? CAMPAIGNS_VIEW.defaults;
  const cols = useMemo(() => keys.flatMap((k) => COLUMNS.filter((c) => c.key === k)), [keys]);

  const isOpen = (id: string) => !!q || open.has(id);
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allIds = useMemo(
    () => nodes.flatMap((c) => [c.id, ...c.children.map((a) => a.id)]),
    [nodes],
  );
  const anyOpen = open.size > 0;
  // Coluna de orçamento só depois da primeira sincronização que traz orçamentos.
  const showBudget = useMemo(
    () =>
      keys.includes("budget") && nodes.some((c) => c.budget || c.children.some((a) => a.budget)),
    [nodes, keys],
  );

  const headerSort = (key: ColumnKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" },
    );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-muted px-3 py-2.5">
        <div className="relative min-w-0 basis-full sm:max-w-72 sm:flex-1 sm:basis-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar campanha, conjunto ou anúncio"
            aria-label="Buscar"
            className="h-8 bg-surface pl-8 pr-8 text-sm"
          />
          {query && (
            <button
              type="button"
              aria-label="Limpar busca"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface-hover hover:text-primary"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <Select
          value={`${sort.key}|${sort.dir}`}
          onValueChange={(v) => {
            const [key, dir] = v.split("|") as [ColumnKey, Sort["dir"]];
            setSort({ key, dir });
          }}
        >
          <SelectTrigger
            aria-label="Ordenar por"
            className="h-8 w-auto gap-1.5 bg-surface text-xs md:hidden"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {cols.flatMap((c) => [
              <SelectItem
                key={`${c.key}|desc`}
                value={`${c.key}|desc`}
              >{`${c.label} · maior primeiro`}</SelectItem>,
              <SelectItem
                key={`${c.key}|asc`}
                value={`${c.key}|asc`}
              >{`${c.label} · menor primeiro`}</SelectItem>,
            ])}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => setOpen(anyOpen ? new Set() : new Set(allIds))}
          disabled={!!q}
        >
          {anyOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
          <span className="hidden sm:inline">{anyOpen ? "Recolher tudo" : "Expandir tudo"}</span>
        </Button>
        {toolbar && <div className="ml-auto flex items-center gap-2">{toolbar}</div>}
      </div>

      {visible.length === 0 && (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          Nada encontrado para “{query}”.
        </p>
      )}

      {/* Celular: cartões expansíveis com as métricas que decidem (gasto, faturamento, ROAS…). */}
      <ul className="divide-y divide-border md:hidden">
        {visible.map((c) => (
          <MobileNode
            key={c.id}
            node={c}
            ancestors={[]}
            depth={0}
            isOpen={isOpen}
            toggle={toggle}
            ctx={ctx}
            cols={cols}
            budget={keys.includes("budget")}
          />
        ))}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table
          className="w-full text-sm"
          style={{ minWidth: 300 + cols.length * 96 + (showBudget ? 120 : 0) }}
        >
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="sticky left-0 z-10 min-w-64 bg-surface px-4 py-2.5 text-left font-medium">
                Nome
              </th>
              {showBudget && (
                <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">Orçamento</th>
              )}
              {cols.map((c) => {
                const active = sort.key === c.key;
                const Icon = sort.dir === "asc" ? ArrowUp : ArrowDown;
                return (
                  <th
                    key={c.key}
                    aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                    className="whitespace-nowrap px-1 py-1.5 text-right font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => headerSort(c.key)}
                      className={cn(
                        "inline-flex flex-row-reverse items-center gap-1 rounded-sm px-2 py-1 transition-colors hover:bg-surface-hover hover:text-foreground",
                        active && "text-foreground",
                      )}
                    >
                      {c.label}
                      <Icon
                        className={cn("h-3.5 w-3.5", active ? "text-primary" : "opacity-0")}
                        aria-hidden
                      />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <DesktopRows
                key={c.id}
                node={c}
                ancestors={[]}
                showBudget={showBudget}
                depth={0}
                isOpen={isOpen}
                toggle={toggle}
                ctx={ctx}
                cols={cols}
              />
            ))}
          </tbody>
          <tfoot>
            {unattributed && unattributed.sales > 0 && (
              <tr className="border-t border-border bg-surface-muted/60 text-muted-foreground">
                <td className="sticky left-0 z-10 bg-surface-muted px-4 py-2.5">
                  <Link
                    to={unattributed.to}
                    className="inline-flex items-center gap-1 hover:text-primary"
                  >
                    Vendas sem campanha identificada
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Link>
                </td>
                {showBudget && <td />}
                {cols.map((c) => (
                  <td key={c.key} className="px-3 py-2.5 text-right tabular-nums">
                    {c.key === "sales"
                      ? fmt.int(unattributed.sales)
                      : c.key === "revenue"
                        ? fmt.money(unattributed.revenueCents, currency)
                        : ""}
                  </td>
                ))}
              </tr>
            )}
            <tr className="border-t-2 border-border-strong font-semibold">
              <td className="sticky left-0 z-10 bg-surface px-4 py-3 text-foreground">
                Total no período
              </td>
              {showBudget && <td />}
              {cols.map((c) => (
                <td
                  key={c.key}
                  className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-foreground"
                >
                  {c.render(totals, ctx)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      {unattributed && unattributed.sales > 0 && (
        <Link
          to={unattributed.to}
          className="flex items-center justify-between gap-3 border-t border-border bg-surface-muted/60 px-4 py-3 text-xs text-muted-foreground md:hidden"
        >
          <span>
            + {unattributed.sales === 1 ? "1 venda" : `${fmt.int(unattributed.sales)} vendas`} sem
            campanha identificada · {fmt.money(unattributed.revenueCents, currency)}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0" />
        </Link>
      )}
    </div>
  );
}

type NodeProps = {
  node: TreeNode;
  /** Campanha e conjunto acima (para avisar se um pai está pausado). */
  ancestors: TreeNode[];
  depth: number;
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  ctx: { currency: string; target: number };
  cols: Column[];
};

function NodeName({
  node,
  ancestors,
  expandable,
  open,
  onToggle,
}: {
  node: TreeNode;
  ancestors: TreeNode[];
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const controls = useMetaControls();
  // Ligado na Meta, mas sem entregar (pai pausado, em análise...): mostra o motivo.
  const reason =
    node.configuredStatus === "ACTIVE" && node.status && node.status !== "ACTIVE"
      ? (DELIVERY_LABELS[node.status] ?? node.status)
      : null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {expandable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? `Recolher ${node.name}` : `Expandir ${node.name}`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-surface-hover hover:text-primary"
        >
          <ChevronRight
            className={cn("h-4 w-4 transition-transform duration-150", open && "rotate-90")}
          />
        </button>
      ) : (
        <span className="w-6 shrink-0" />
      )}
      {controls ? (
        <DeliveryToggle node={node} ancestors={ancestors} />
      ) : (
        <StatusDot status={node.status} />
      )}
      {node.level === "ad" && <Thumb src={node.thumbnailUrl} alt="" size="sm" />}
      <div className="min-w-0">
        <p
          className={cn("truncate text-foreground", node.level === "campaign" && "font-medium")}
          title={node.name}
        >
          {node.name}
        </p>
        {(node.level !== "campaign" || reason) && (
          <p className="text-[11px] leading-4 text-muted-foreground">
            {node.level !== "campaign" && LEVEL_LABELS[node.level]}
            {reason && (
              <>
                {node.level !== "campaign" && " · "}
                <span className="whitespace-nowrap text-warning-strong">{reason}</span>
              </>
            )}
            {node.level === "ad" && node.previewLink && (
              <>
                {" · "}
                <a
                  href={node.previewLink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 hover:text-primary"
                >
                  ver anúncio
                  <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function DesktopRows({
  node,
  ancestors,
  depth,
  isOpen,
  toggle,
  ctx,
  cols,
  showBudget,
}: NodeProps & { showBudget: boolean }) {
  const open = isOpen(node.id);
  const expandable = node.children.length > 0;
  return (
    <Fragment>
      <tr
        className={cn(
          "group border-b border-border transition-colors hover:bg-surface-hover",
          depth > 0 && "bg-surface-muted",
        )}
      >
        <td
          className={cn(
            "sticky left-0 z-10 max-w-96 py-2 pr-4 transition-colors group-hover:bg-surface-hover",
            depth > 0 ? "bg-surface-muted" : "bg-surface",
          )}
          style={{ paddingLeft: `${0.75 + depth * 1.5}rem` }}
        >
          <NodeName
            node={node}
            ancestors={ancestors}
            expandable={expandable}
            open={open}
            onToggle={() => toggle(node.id)}
          />
        </td>
        {showBudget && (
          <td className="whitespace-nowrap px-3 py-2 text-right text-sm">
            <BudgetValue node={node} />
          </td>
        )}
        {cols.map((c) => (
          <td
            key={c.key}
            className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-foreground"
          >
            {c.render(node.metrics, ctx)}
          </td>
        ))}
      </tr>
      {open &&
        node.children.map((child) => (
          <DesktopRows
            key={child.id}
            node={child}
            ancestors={[...ancestors, node]}
            showBudget={showBudget}
            depth={depth + 1}
            isOpen={isOpen}
            toggle={toggle}
            ctx={ctx}
            cols={cols}
          />
        ))}
    </Fragment>
  );
}

// No celular, volume e custo de mídia vão numa linha de rodapé; o resto vira grade.
const MOBILE_FOOTNOTE = new Set<ColumnKey>(["impressions", "clicks", "ctr", "cpc", "cpm"]);

function MobileNode({
  node,
  ancestors,
  depth,
  isOpen,
  toggle,
  ctx,
  cols,
  budget,
}: NodeProps & { budget: boolean }) {
  const open = isOpen(node.id);
  const expandable = node.children.length > 0;
  const m = node.metrics;
  const cells: [string, ReactNode][] = cols
    .filter((c) => !MOBILE_FOOTNOTE.has(c.key))
    .map((c) => [
      c.label,
      c.key === "roas" ? (
        <RoasBadge key="roas" roas={derived.roas(m)} target={ctx.target} className="-mx-1.5" />
      ) : (
        c.render(m, ctx)
      ),
    ]);
  const footnote = cols.filter((c) => MOBILE_FOOTNOTE.has(c.key));
  return (
    <li className={cn(depth > 0 && "border-l-2 border-primary/25 bg-surface-muted/40")}>
      {/* O cartão inteiro abre e fecha; o botão da seta continua sendo o controle acessível. */}
      <div
        className={cn("py-3 pr-4 pl-2", expandable && "cursor-pointer")}
        onClick={(e) => {
          if (expandable && !(e.target as HTMLElement).closest("a,button")) toggle(node.id);
        }}
      >
        <NodeName
          node={node}
          ancestors={ancestors}
          expandable={expandable}
          open={open}
          onToggle={() => toggle(node.id)}
        />
        {budget && node.level !== "ad" && (node.budget || node.usesCampaignBudget) && (
          <p className="mt-1.5 flex items-center gap-1.5 pl-8 text-xs text-muted-foreground">
            Orçamento <BudgetValue node={node} compact />
          </p>
        )}
        {cells.length > 0 && (
          <dl className="mt-2.5 grid grid-cols-3 gap-x-3 gap-y-2 pl-8">
            {cells.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-[11px] text-muted-foreground">{label}</dt>
                <dd className="text-sm font-medium tabular-nums whitespace-nowrap text-foreground">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {footnote.length > 0 && (
          <p className="mt-1.5 pl-8 text-[11px] text-muted-foreground tabular-nums">
            {footnote.map((c, i) => (
              <Fragment key={c.key}>
                {i > 0 && " · "}
                {c.label} {c.render(m, ctx)}
              </Fragment>
            ))}
          </p>
        )}
      </div>
      {open && expandable && (
        <ul className="divide-y divide-border border-t border-border pl-2">
          {node.children.map((child) => (
            <MobileNode
              key={child.id}
              node={child}
              ancestors={[...ancestors, node]}
              depth={depth + 1}
              isOpen={isOpen}
              toggle={toggle}
              ctx={ctx}
              cols={cols}
              budget={budget}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
