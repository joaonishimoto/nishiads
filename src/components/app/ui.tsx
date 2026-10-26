import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  RotateCw,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { nextSort, sortRows, type SortKey, type SortState } from "@/components/app/table-sort";
import type { PageSkeletonVariant } from "@/components/app/page-skeleton-variant";
export type { PageSkeletonVariant } from "@/components/app/page-skeleton-variant";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-3 border-b border-border pb-5 sm:flex sm:min-h-20 sm:items-center sm:justify-between sm:pb-6">
      <div className="min-w-0 self-center">
        <h1 className="text-xl font-semibold leading-7 tracking-[-0.015em] text-foreground sm:text-2xl sm:leading-8">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 max-w-prose text-sm leading-5 text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="col-span-2 flex shrink-0 flex-wrap items-center gap-2 sm:col-span-1 sm:justify-end sm:self-center">
          {actions}
        </div>
      )}
    </header>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong bg-surface-muted/40 px-6 text-center",
        compact ? "min-h-40 py-8" : "min-h-64 py-12",
      )}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-surface text-primary shadow-xs">
        <Icon className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
      </span>
      <h2 className="mt-4 text-sm font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-sm text-sm leading-5 text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A section or page that failed to load: what is missing, in pt-BR, and one way to try again. */
export function LoadError({
  children,
  onRetry,
  retrying = false,
}: {
  children: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-md border border-danger/30 bg-danger/10 p-4 text-sm text-danger-strong sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="min-w-0">{children}</p>
      {onRetry && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0 self-start bg-surface sm:self-auto"
          loading={retrying}
          loadingText={"Tentando…"}
          onClick={onRetry}
        >
          <RotateCw className="h-4 w-4" />
          {"Tentar novamente"}
        </Button>
      )}
    </div>
  );
}

function SkeletonStatCards({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-4">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-lg border border-border bg-surface p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-7 w-32" />
          <Skeleton className="mt-2 h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

function SkeletonPanel({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-surface", className)}>
      <div className="border-b border-border px-4 py-3">
        <Skeleton className="h-4 w-36" />
      </div>
      <div className="space-y-3 p-4">
        {Array.from({ length: rows }, (_, row) => (
          <Skeleton key={row} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

function SkeletonTabs({ count }: { count: number }) {
  return (
    <div className="flex gap-6 overflow-hidden border-b border-border pb-3">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className={cn("h-4 shrink-0", index === 0 ? "w-24" : "w-20")} />
      ))}
    </div>
  );
}

export function PageSkeleton({ variant = "table" }: { variant?: PageSkeletonVariant }) {
  const detail = variant === "detail";
  return (
    <div className="flex min-w-0 flex-col gap-6" role="status" aria-label="Carregando conteúdo">
      <div className="flex min-h-20 items-center justify-between gap-4 border-b border-border pb-6">
        <div className="flex min-w-0 items-center gap-3">
          {detail && <Skeleton className="h-8 w-8 shrink-0" />}
          <div className="min-w-0 space-y-2">
            <Skeleton className="h-7 w-40 max-w-[55vw]" />
            <Skeleton className="h-4 w-72 max-w-[72vw]" />
          </div>
        </div>
        {variant !== "overview" && variant !== "settings" && (
          <div className="flex shrink-0 gap-2">
            {(detail || variant === "board") && <Skeleton className="hidden h-9 w-24 sm:block" />}
            <Skeleton className="h-9 w-28" />
          </div>
        )}
      </div>

      {variant === "overview" && (
        <>
          <SkeletonStatCards />
          <div className="grid gap-4 lg:grid-cols-3">
            <SkeletonPanel rows={5} className="lg:col-span-2" />
            <SkeletonPanel rows={4} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <SkeletonPanel />
            <SkeletonPanel />
            <SkeletonPanel rows={2} className="lg:col-span-2" />
          </div>
        </>
      )}

      {variant === "board" && (
        <>
          <div className="flex gap-3 rounded-lg border border-border bg-surface p-3">
            <Skeleton className="h-9 w-full max-w-sm" />
            <Skeleton className="hidden h-9 w-40 lg:block" />
            <Skeleton className="hidden h-9 w-40 lg:block" />
          </div>
          <div className="overflow-hidden pb-3">
            <div className="grid w-max min-w-full auto-cols-[min(17rem,calc(100vw-2rem))] grid-flow-col gap-3">
              {Array.from({ length: 6 }, (_, column) => (
                <div
                  key={column}
                  className="flex min-h-80 flex-col rounded-lg border border-border bg-surface-muted"
                >
                  <div className="border-b border-border px-3 py-3">
                    <div className="flex justify-between">
                      <Skeleton className="h-3 w-20 bg-border" />
                      <Skeleton className="h-3 w-4 bg-border" />
                    </div>
                    <Skeleton className="mt-2 h-3 w-16 bg-border" />
                  </div>
                  <div className="flex flex-col gap-2 p-2">
                    {Array.from({ length: [2, 1, 2, 1, 1, 0][column] ?? 0 }, (_, card) => (
                      <div
                        key={card}
                        className="space-y-3 rounded-lg border border-border bg-surface p-3.5"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 space-y-2">
                            <Skeleton className="h-4 w-4/5" />
                            <Skeleton className="h-3 w-1/2" />
                          </div>
                          <Skeleton className="h-6 w-6 rounded-full" />
                        </div>
                        <Skeleton className="h-5 w-24" />
                        <Skeleton className="h-3 w-3/5" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {(variant === "cards" || variant === "library") && (
        <>
          {variant === "library" && (
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap gap-1.5">
                {Array.from({ length: 5 }, (_, index) => (
                  <Skeleton key={index} className="h-7 w-24 rounded-full" />
                ))}
              </div>
              <Skeleton className="h-9 w-full lg:w-72" />
            </div>
          )}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="space-y-4 rounded-lg border border-border bg-surface p-4">
                <div className="flex justify-between gap-3">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-5 w-16" />
                </div>
                {variant === "cards" ? (
                  <Skeleton className="h-2 w-full" />
                ) : (
                  <div className="space-y-2">
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-4/5" />
                  </div>
                )}
                <div className="flex justify-between">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {detail && (
        <div className="space-y-5">
          <SkeletonTabs count={5} />
          <SkeletonStatCards />
          <div className="grid gap-6 xl:grid-cols-2">
            <SkeletonPanel rows={4} />
            <SkeletonPanel rows={4} />
          </div>
        </div>
      )}

      {variant === "settings" && (
        <div className="max-w-3xl space-y-5">
          <SkeletonTabs count={2} />
          <div className="flex items-center gap-4 rounded-lg border border-border bg-surface p-4">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56 max-w-[50vw]" />
            </div>
          </div>
          <div className="space-y-4 rounded-lg border border-border bg-surface p-4">
            <Skeleton className="h-4 w-32" />
            <div className="grid gap-4 grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="space-y-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <Skeleton className="h-9 w-28" />
            </div>
          </div>
        </div>
      )}

      {variant === "table" && (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border bg-surface-muted px-3 py-2.5">
            <Skeleton className="h-8 w-64 max-w-[60vw]" />
            <Skeleton className="h-3 w-16" />
          </div>
          <div className="border-b border-border px-4 py-3">
            <Skeleton className="h-3 w-3/5" />
          </div>
          {Array.from({ length: 6 }, (_, row) => (
            <div
              key={row}
              className="grid grid-cols-[minmax(8rem,2fr)_repeat(3,minmax(5rem,1fr))] gap-4 border-b border-border px-4 py-3 last:border-0"
            >
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      )}
      <span className="sr-only">Carregando...</span>
    </div>
  );
}

export function Panel({
  title,
  description,
  children,
  className,
  action,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-surface", className)}>
      {title && (
        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-3 sm:p-4">
      <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-lg font-semibold tracking-tight text-foreground tabular-nums [overflow-wrap:anywhere] sm:mt-2 sm:text-2xl">
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function KpiGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">{children}</div>;
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";
// Tinted background + the tone's strong text: every pair stays at 5.5:1 or more.
const tones: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/12 text-success-strong",
  warning: "bg-warning/12 text-warning-strong",
  danger: "bg-danger/12 text-danger-strong",
  info: "bg-info/12 text-info-strong",
  accent: "bg-accent text-accent-foreground",
};
export function Status({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-0.5 text-xs font-medium leading-4 [&_svg]:size-3",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Avatar({
  name,
  showName = true,
  size = "sm",
}: {
  name: string;
  showName?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const sizes = { sm: "h-6 w-6 text-[10px]", md: "h-8 w-8 text-xs", lg: "h-10 w-10 text-sm" };
  const badge = (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground",
        sizes[size],
      )}
    >
      {initials}
    </span>
  );
  if (!showName)
    return (
      <span role="img" aria-label={name} title={name} className="inline-flex">
        {badge}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-2">
      {badge}
      <span className="truncate">{name}</span>
    </span>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

/** Conta suavemente de um valor a outro (sobe e desce), sincronizada com a barra de progresso. */
export function useAnimatedNumber(value: number, duration = 500): number {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = from + (value - from) * eased;
      fromRef.current = next;
      setDisplay(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return display;
}

/** Número (padrão: porcentagem inteira) que conta suavemente ao subir ou descer. */
export function AnimatedNumber({
  value,
  suffix = "%",
  className,
}: {
  value: number;
  suffix?: string;
  className?: string;
}) {
  const display = useAnimatedNumber(value);
  return (
    <span className={cn("tabular-nums", className)}>
      {Math.round(display)}
      {suffix}
    </span>
  );
}

export interface Column<T> {
  label: string;
  render: (row: T) => ReactNode;
  align?: "right";
  /** Leave out of the phone card (e.g. a column that repeats the title). */
  hideOnMobile?: boolean;
  /** Makes the column sortable: the raw value behind the cell (text, number, ISO date, or a tuple such as [currency, amount]). */
  sortValue?: (row: T) => SortKey;
}

const NO_SORT = "__default";

/** Row selection for bulk actions; the table keeps it limited to the rows currently visible. */
export interface TableSelection {
  selected: ReadonlySet<string>;
  onChange: (selected: Set<string>) => void;
}

export function DataTable<T extends { id: string }>({
  rows,
  columns,
  searchText,
  onRowClick,
  emptyState,
  toolbar,
  selection,
}: {
  rows: T[];
  columns: Column<T>[];
  searchText?: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyState?: ReactNode;
  /** Extra filters shown beside the search field. */
  toolbar?: ReactNode;
  selection?: TableSelection;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortState | null>(null);
  const matching =
    searchText && q
      ? rows.filter((r) => searchText(r).toLowerCase().includes(q.toLowerCase()))
      : rows;
  const sortable = columns.filter((c) => c.sortValue);
  const sortColumn = sort && columns.find((c) => c.label === sort.column && c.sortValue);
  const filtered =
    sort && sortColumn?.sortValue
      ? sortRows(matching, sortColumn.sortValue, sort.direction)
      : matching;
  // Rows hidden by a filter or the search leave the selection, so bulk actions only touch what is on screen.
  const visibleKey = filtered.map((r) => r.id).join(",");
  useEffect(() => {
    if (!selection) return;
    const visible = new Set(visibleKey ? visibleKey.split(",") : []);
    const kept = [...selection.selected].filter((id) => visible.has(id));
    if (kept.length !== selection.selected.size) selection.onChange(new Set(kept));
  }, [visibleKey, selection]);
  const selectedVisible = selection
    ? filtered.filter((r) => selection.selected.has(r.id)).length
    : 0;
  const allState: boolean | "indeterminate" =
    selectedVisible === 0 ? false : selectedVisible === filtered.length ? true : "indeterminate";
  const toggleAll = () =>
    selection?.onChange(allState === true ? new Set() : new Set(filtered.map((r) => r.id)));
  const toggle = (id: string) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selection.onChange(next);
  };
  const rowBox = (r: T) =>
    selection && (
      <Checkbox
        aria-label={"Selecionar linha"}
        checked={selection.selected.has(r.id)}
        onCheckedChange={() => toggle(r.id)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        className="pointer-coarse:h-5 pointer-coarse:w-5"
      />
    );
  if (rows.length === 0 && emptyState) return emptyState;
  return (
    <Panel>
      {(searchText || toolbar || sortable.length > 0) && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface-muted px-3 py-2.5",
            !searchText && !toolbar && "md:hidden",
          )}
        >
          {selection && filtered.length > 0 && (
            <Checkbox
              aria-label={"Selecionar todos os registros visíveis"}
              checked={allState}
              onCheckedChange={toggleAll}
              className="md:hidden pointer-coarse:h-5 pointer-coarse:w-5"
            />
          )}
          {searchText && (
            <div className="relative min-w-0 flex-1 md:w-64 md:flex-none">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={"Filtrar..."}
                className="h-8 bg-surface pl-8 pr-8 text-sm"
              />
              {q && (
                <button
                  type="button"
                  aria-label={"Limpar filtro"}
                  onClick={() => setQ("")}
                  className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-surface-hover hover:text-primary"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
          {/* Phones have no column headers, so the sort lives in the toolbar. */}
          {sortable.length > 0 && (
            <Select
              value={sort ? `${sort.column}|${sort.direction}` : NO_SORT}
              onValueChange={(value) => {
                const [column, direction] = value.split("|");
                setSort(
                  value === NO_SORT || !column
                    ? null
                    : { column, direction: direction === "desc" ? "desc" : "asc" },
                );
              }}
            >
              <SelectTrigger
                aria-label={"Ordenar por"}
                className="h-8 w-auto min-w-0 max-w-40 gap-1.5 bg-surface text-xs md:hidden [&>span]:truncate"
              >
                <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <SelectValue placeholder={"Ordenar"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SORT}>{"Ordem padrão"}</SelectItem>
                {sortable.flatMap((c) => [
                  <SelectItem
                    key={`${c.label}|asc`}
                    value={`${c.label}|asc`}
                  >{`${c.label} · crescente`}</SelectItem>,
                  <SelectItem
                    key={`${c.label}|desc`}
                    value={`${c.label}|desc`}
                  >{`${c.label} · decrescente`}</SelectItem>,
                ])}
              </SelectContent>
            </Select>
          )}
          <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
            {filtered.length} {filtered.length === 1 ? "registro" : "registros"}
          </span>
          {toolbar && <div className="w-full min-w-0">{toolbar}</div>}
        </div>
      )}
      {/* Phones: each row becomes a card — first column as title, the rest as label/value lines. */}
      <ul className="divide-y divide-border md:hidden">
        {filtered.map((r) => {
          const [head, ...rest] = columns.filter((c) => !c.hideOnMobile);
          const body = (
            <>
              {head && (
                <div className="flex min-w-0 items-start gap-3 text-sm font-medium text-foreground">
                  {selection && <span className="pt-0.5">{rowBox(r)}</span>}
                  <div className="min-w-0 flex-1">{head.render(r)}</div>
                </div>
              )}
              {rest.length > 0 && (
                <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
                  {rest.map((c) => (
                    <div key={c.label} className="contents">
                      <dt className="text-muted-foreground">{c.label}</dt>
                      <dd className="min-w-0 justify-self-end text-right text-foreground [overflow-wrap:anywhere]">
                        {c.render(r)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </>
          );
          return (
            <li key={r.id}>
              {onRowClick ? (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onRowClick(r)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onRowClick(r);
                    }
                  }}
                  className={cn(
                    "block w-full px-4 py-3.5 text-left transition-colors active:bg-surface-selected",
                    selection?.selected.has(r.id) &&
                      "bg-surface-selected shadow-[inset_3px_0_0_var(--primary)]",
                  )}
                >
                  {body}
                </div>
              ) : (
                <div
                  className={cn(
                    "px-4 py-3.5",
                    selection?.selected.has(r.id) &&
                      "bg-surface-selected shadow-[inset_3px_0_0_var(--primary)]",
                  )}
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">
            {"Nenhum resultado"}
          </li>
        )}
      </ul>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface text-left text-xs text-muted-foreground">
              {selection && (
                <th className="w-10 px-4 py-2">
                  <Checkbox
                    aria-label={"Selecionar todos os registros visíveis"}
                    checked={allState}
                    onCheckedChange={toggleAll}
                    disabled={filtered.length === 0}
                  />
                </th>
              )}
              {columns.map((c) => {
                if (!c.sortValue)
                  return (
                    <th
                      key={c.label}
                      className={cn(
                        "whitespace-nowrap px-4 py-2.5 font-medium",
                        c.align === "right" && "text-right",
                      )}
                    >
                      {c.label}
                    </th>
                  );
                const direction = sort?.column === c.label ? sort.direction : null;
                const Icon =
                  direction === "asc" ? ArrowUp : direction === "desc" ? ArrowDown : ArrowUpDown;
                return (
                  <th
                    key={c.label}
                    aria-sort={
                      direction === "asc"
                        ? "ascending"
                        : direction === "desc"
                          ? "descending"
                          : "none"
                    }
                    className={cn(
                      "whitespace-nowrap px-2 py-1.5 font-medium",
                      c.align === "right" && "text-right",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSort(nextSort(sort, c.label))}
                      title={
                        direction === "asc"
                          ? "Ordenar decrescente"
                          : direction === "desc"
                            ? "Voltar à ordem padrão"
                            : "Ordenar crescente"
                      }
                      className={cn(
                        "group inline-flex items-center gap-1 rounded-sm px-2 py-1 transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        c.align === "right" && "flex-row-reverse",
                        direction && "text-foreground",
                      )}
                    >
                      {c.label}
                      <Icon
                        aria-hidden="true"
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          direction ? "text-primary" : "opacity-40 group-hover:opacity-100",
                        )}
                      />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.id}
                onClick={() => onRowClick?.(r)}
                className={cn(
                  "border-b border-border transition-colors last:border-0",
                  onRowClick && "cursor-pointer hover:bg-surface-hover",
                  selection?.selected.has(r.id) &&
                    "bg-surface-selected shadow-[inset_3px_0_0_var(--primary)]",
                )}
              >
                {selection && (
                  <td className="w-10 px-4 py-3" onClick={(event) => event.stopPropagation()}>
                    {rowBox(r)}
                  </td>
                )}
                {columns.map((c) => (
                  <td
                    key={c.label}
                    className={cn(
                      "px-4 py-3 text-foreground",
                      c.align === "right" && "text-right tabular-nums",
                    )}
                  >
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length + (selection ? 1 : 0)}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  {"Nenhum resultado"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border py-2 last:border-0">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="min-w-0 text-right text-foreground">{v}</span>
    </div>
  );
}

/** Tela cheia de carregamento (sessão, troca de workspace). */
export function FullScreenLoader({ label = "Carregando…" }: { label?: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background" aria-busy="true">
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
