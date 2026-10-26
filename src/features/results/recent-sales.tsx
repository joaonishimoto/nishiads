import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Status } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { AttributionPath, originParts } from "@/features/sales/attribution-path";
import { SALE_STATUS_META } from "@/features/sales/meta";
import { saleInstant, type ResultSale } from "@/features/results/metrics";
import { formatDateTime, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

/** "agora", "há 5 min", "há 3 h"; depois de um dia, data e hora. */
export function timeAgo(iso: string, timeZone: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  if (minutes < 24 * 60) return `há ${Math.floor(minutes / 60)} h`;
  return formatDateTime(iso, timeZone);
}

/** Marca por alguns segundos as linhas que chegaram depois da primeira renderização. */
export function useFreshIds(ids: string[]): Set<string> {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const key = ids.join(",");
  useEffect(() => {
    if (known.current === null) {
      known.current = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !known.current!.has(id));
    added.forEach((id) => known.current!.add(id));
    if (added.length === 0) return;
    setFresh((prev) => new Set([...prev, ...added]));
    const timer = setTimeout(
      () => setFresh((prev) => new Set([...prev].filter((id) => !added.includes(id)))),
      6000,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return fresh;
}

export function SaleLine({
  sale,
  fresh = false,
  compact = false,
}: {
  sale: ResultSale;
  fresh?: boolean;
  compact?: boolean;
}) {
  const { workspace } = useWorkspace();
  const status = SALE_STATUS_META[sale.status];
  const [, tick] = useState(0);
  // Atualiza o "há x min" a cada minuto.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const dimmed = ["refunded", "chargeback", "canceled"].includes(sale.status);
  return (
    <li
      className={cn(
        "transition-colors duration-1000",
        fresh && "bg-success/8 animate-in fade-in slide-in-from-top-2 duration-500",
      )}
    >
      <Link
        to={`/w/${workspace.id}/vendas/${sale.id}`}
        className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 px-4 py-3 transition-colors hover:bg-surface-hover"
      >
        <span className="flex min-w-0 items-center gap-2">
          {fresh && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-label="Nova" />
          )}
          <span className="truncate text-sm font-medium text-foreground">
            {sale.product_name ?? "Produto sem nome"}
          </span>
        </span>
        <span
          className={cn(
            "text-right text-sm font-semibold tabular-nums",
            sale.status === "approved" ? "text-foreground" : "text-muted-foreground",
            dimmed && "line-through",
          )}
        >
          {sale.status === "trialing"
            ? sale.trial_converted_at
              ? "Pagou"
              : "Em teste"
            : formatMoney(sale.gross_amount_cents, sale.currency)}
        </span>
        <span className="min-w-0 text-xs">
          {compact ? (
            <span
              className={cn(
                "block truncate",
                sale.attribution_status === "matched" ? "text-foreground" : "text-muted-foreground",
              )}
              title={originParts(sale).join(" › ")}
            >
              {originParts(sale).length
                ? [originParts(sale).at(-1), originParts(sale)[0]]
                    .filter((v, i, a) => a.indexOf(v) === i)
                    .join(" · ")
                : "Sem origem"}
            </span>
          ) : (
            <AttributionPath
              sale={sale}
              className={cn(
                "inline-flex min-w-0 max-w-full items-center gap-x-1",
                compact ? "flex-nowrap overflow-hidden" : "flex-wrap",
                sale.attribution_status === "matched" ? "text-foreground" : "text-muted-foreground",
              )}
            />
          )}
        </span>
        <span className="text-right text-xs text-muted-foreground tabular-nums">
          {timeAgo(saleInstant(sale), workspace.timezone)}
        </span>
        {!compact && (sale.status !== "approved" || sale.attribution_status === "partial") && (
          <span className="col-span-2 mt-1 flex flex-wrap gap-1.5">
            {sale.status !== "approved" && <Status tone={status.tone}>{status.label}</Status>}
            {sale.attribution_status === "partial" && (
              <Status tone="warning">Origem parcial</Status>
            )}
          </span>
        )}
      </Link>
    </li>
  );
}
