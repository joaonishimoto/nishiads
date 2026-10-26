import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";
import { CalendarDays, Megaphone, Package } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { readLocal, writeLocal } from "@/lib/storage";
import {
  daySpan,
  daysToRange,
  PERIOD_LABELS,
  periodDays,
  previousDays,
  ymdInZone,
  type DateRange,
  type PeriodKey,
} from "@/lib/period";

const PERIODS: PeriodKey[] = ["today", "yesterday", "7d", "30d", "custom"];
/** Parâmetros dos filtros globais: os mesmos no Dashboard e em Campanhas. */
const FILTER_PARAMS = ["periodo", "de", "ate", "conta", "produto"] as const;
const ALL = "__all";

export type ResultFiltersState = {
  period: PeriodKey;
  custom: { from: string; to: string };
  today: string;
  days: { first: string; last: string };
  range: DateRange;
  previous: { days: { first: string; last: string }; range: DateRange };
  /** "vs. 7 dias antes" e afins. */
  comparisonLabel: string;
  /**
   * Hoje compara com ontem até a mesma hora. Só vale para vendas: a Meta informa o
   * gasto por dia, então as métricas de gasto ficam sem comparação.
   */
  partialComparison: boolean;
  accountId: string | null;
  productId: string | null;
  set: (key: (typeof FILTER_PARAMS)[number], value: string | null) => void;
};

function comparisonLabel(period: PeriodKey, span: number): string {
  if (period === "today") return "vs. ontem até agora";
  if (period === "yesterday") return "vs. anteontem";
  return span === 1 ? "vs. dia anterior" : `vs. ${span} dias antes`;
}

/**
 * Período, conta e produto vivem na URL (dá para compartilhar o link) e são lembrados
 * por workspace: abrir o Dashboard depois de Campanhas mantém o mesmo recorte.
 */
export function useResultFilters(): ResultFiltersState {
  const { workspace } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const storageKey = `nishiads:filtros:${workspace.id}`;

  const stored = FILTER_PARAMS.some((k) => params.has(k)) ? null : readLocal(storageKey);
  useEffect(() => {
    if (!stored) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of new URLSearchParams(stored)) {
          if ((FILTER_PARAMS as readonly string[]).includes(k)) next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  }, [stored, setParams]);

  const own = new URLSearchParams();
  for (const k of FILTER_PARAMS) {
    const v = params.get(k);
    if (v) own.set(k, v);
  }
  const ownString = own.toString();
  useEffect(() => {
    if (!stored) writeLocal(storageKey, ownString || null);
  }, [ownString, storageKey, stored]);

  const tz = workspace.timezone;
  const today = ymdInZone(new Date(), tz);
  const raw = params.get("periodo") as PeriodKey;
  const period: PeriodKey = PERIODS.includes(raw) ? raw : "7d";
  const from = params.get("de") ?? today;
  const to = params.get("ate") ?? today;
  const accountId = params.get("conta");
  const productId = params.get("produto");

  return useMemo(() => {
    const custom = { from, to };
    const days = periodDays(period, tz, new Date(), custom);
    const prevDays = previousDays(days);
    const partial = period === "today";
    const prevRange = daysToRange(prevDays, tz);
    if (partial) prevRange.to = new Date(Date.now() - 86_400_000).toISOString();
    return {
      period,
      custom,
      today,
      days,
      range: daysToRange(days, tz),
      previous: { days: prevDays, range: prevRange },
      partialComparison: partial,
      comparisonLabel: comparisonLabel(period, daySpan(days.first, days.last)),
      accountId,
      productId,
      set: (key, value) =>
        setParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            if (value === null) next.delete(key);
            else next.set(key, value);
            return next;
          },
          { replace: true },
        ),
    };
    // `today` entra na chave para virar o dia sem recarregar.
  }, [period, tz, from, to, today, accountId, productId, setParams]);
}

export function FilterBar({
  filters,
  accounts,
  products,
}: {
  filters: ResultFiltersState;
  accounts: { id: string; name: string }[];
  products: { id: string; name: string }[];
}) {
  const showAccounts = accounts.length > 1 || (!!filters.accountId && accounts.length > 0);
  const showProducts = products.length > 1 || (!!filters.productId && products.length > 0);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <Select
          value={filters.period}
          onValueChange={(v) => filters.set("periodo", v === "7d" ? null : v)}
        >
          <SelectTrigger
            className={showAccounts && showProducts ? "col-span-2 sm:w-48" : "sm:w-48"}
            aria-label="Período"
          >
            <span className="!flex min-w-0 items-center gap-2">
              <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate">
                <SelectValue />
              </span>
            </span>
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p} value={p}>
                {PERIOD_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {showAccounts && (
          <Select
            value={filters.accountId ?? ALL}
            onValueChange={(v) => filters.set("conta", v === ALL ? null : v)}
          >
            <SelectTrigger className="min-w-0 sm:w-56" aria-label="Conta de anúncio">
              <span className="!flex min-w-0 items-center gap-2">
                <Megaphone className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 truncate">
                  <SelectValue />
                </span>
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todas as contas</SelectItem>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {showProducts && (
          <Select
            value={filters.productId ?? ALL}
            onValueChange={(v) => filters.set("produto", v === ALL ? null : v)}
          >
            <SelectTrigger className="min-w-0 sm:w-56" aria-label="Produto">
              <span className="!flex min-w-0 items-center gap-2">
                <Package className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 truncate">
                  <SelectValue />
                </span>
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos os produtos</SelectItem>
              {products.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {filters.period === "custom" && (
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Input
            type="date"
            aria-label="De"
            className="sm:w-44"
            value={filters.custom.from}
            max={filters.today}
            onChange={(e) => filters.set("de", e.target.value || null)}
          />
          <Input
            type="date"
            aria-label="Até"
            className="sm:w-44"
            value={filters.custom.to}
            min={filters.custom.from}
            max={filters.today}
            onChange={(e) => filters.set("ate", e.target.value || null)}
          />
        </div>
      )}
    </div>
  );
}
