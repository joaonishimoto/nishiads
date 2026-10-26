import { useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, ImageOff, Info, Target } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip as Hint, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { readLocal, writeLocal } from "@/lib/storage";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DailyPoint } from "@/features/results/metrics";

export const fmt = {
  int: (n: number) => n.toLocaleString("pt-BR"),
  pct: (n: number | null, digits = 0) =>
    n === null
      ? "—"
      : `${(n * 100).toLocaleString("pt-BR", { maximumFractionDigits: digits, minimumFractionDigits: digits })}%`,
  roas: (n: number | null) =>
    n === null
      ? "—"
      : `${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x`,
  money: (cents: number | null, currency: string) =>
    cents === null ? "—" : formatMoney(cents, currency),
  /** R$ 12,3 mil: eixos e espaços curtos. */
  compactMoney: (cents: number, currency: string) =>
    new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(cents / 100),
};

/** Cartão de KPI com a variação contra o período anterior. `invert`: subir é ruim (gasto, CPA). */
export function MetricCard({
  label,
  value,
  delta,
  invert = false,
  hint,
  info,
  emphasis = false,
  tone,
}: {
  label: string;
  value: string;
  delta?: number | null;
  invert?: boolean;
  hint?: ReactNode;
  info?: string;
  emphasis?: boolean;
  tone?: "success" | "danger";
}) {
  const good = delta === null || delta === undefined ? null : invert ? delta < 0 : delta > 0;
  const Arrow = delta !== null && delta !== undefined && delta < 0 ? ArrowDownRight : ArrowUpRight;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col rounded-lg border bg-surface p-3 sm:p-4",
        emphasis ? "border-primary/30 shadow-[inset_0_2px_0_var(--primary)]" : "border-border",
      )}
    >
      <div className="flex items-center gap-1">
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        {info && (
          <Hint>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="shrink-0 rounded-sm text-muted-foreground hover:text-primary"
                aria-label={`Sobre ${label}`}
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{info}</TooltipContent>
          </Hint>
        )}
      </div>
      <p
        className={cn(
          "mt-1.5 text-lg font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere] sm:text-2xl",
          tone === "success"
            ? "text-success-strong"
            : tone === "danger"
              ? "text-danger-strong"
              : "text-foreground",
        )}
      >
        {value}
      </p>
      <div className="mt-auto flex min-h-5 min-w-0 items-center gap-x-1.5 overflow-hidden whitespace-nowrap pt-1 text-xs text-muted-foreground">
        {delta !== null && delta !== undefined && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 font-medium tabular-nums",
              good ? "text-success-strong" : "text-danger-strong",
            )}
          >
            <Arrow className="h-3.5 w-3.5" aria-hidden />
            {fmt.pct(Math.abs(delta), Math.abs(delta) < 0.1 ? 1 : 0)}
            <span className="sr-only">{delta < 0 ? "de queda" : "de alta"}</span>
          </span>
        )}
        {hint && <span className="truncate">{hint}</span>}
      </div>
    </div>
  );
}

const ROAS_DEFAULT = 2;

/** Meta de ROAS do usuário (por workspace, neste aparelho): pinta as linhas da tabela. */
export function useRoasTarget(workspaceId: string): [number, (n: number) => void] {
  const key = `nishiads:meta-roas:${workspaceId}`;
  const [target, setTarget] = useState(() => {
    const n = Number(readLocal(key));
    return Number.isFinite(n) && n > 0 ? n : ROAS_DEFAULT;
  });
  return [
    target,
    (n) => {
      setTarget(n);
      writeLocal(key, String(n));
    },
  ];
}

export type RoasTone = "good" | "ok" | "bad" | "none";

export function roasTone(roas: number | null, target: number): RoasTone {
  if (roas === null) return "none";
  if (roas >= target) return "good";
  if (roas >= 1) return "ok";
  return "bad";
}

export function RoasBadge({
  roas,
  target,
  className,
}: {
  roas: number | null;
  target: number;
  className?: string;
}) {
  const tone = roasTone(roas, target);
  return (
    <span
      className={cn(
        "inline-flex items-center justify-end rounded-sm px-1.5 py-0.5 text-sm font-semibold tabular-nums",
        tone === "good" && "bg-success/12 text-success-strong",
        tone === "ok" && "bg-warning/12 text-warning-strong",
        tone === "bad" && "bg-danger/12 text-danger-strong",
        tone === "none" && "text-muted-foreground",
        className,
      )}
      title={
        tone === "good"
          ? `Na meta (≥ ${fmt.roas(target)})`
          : tone === "ok"
            ? `Paga o gasto, abaixo da meta de ${fmt.roas(target)}`
            : tone === "bad"
              ? "Abaixo de 1x: gasta mais do que fatura"
              : "Sem gasto no período"
      }
    >
      {fmt.roas(roas)}
    </span>
  );
}

export function RoasTargetButton({
  target,
  onChange,
}: {
  target: number;
  onChange: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(target).replace(".", ","));
  const [open, setOpen] = useState(false);
  const save = () => {
    const n = Number(draft.replace(",", "."));
    if (Number.isFinite(n) && n > 0 && n <= 100) onChange(Math.round(n * 100) / 100);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setDraft(String(target).replace(".", ","));
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Target />
          <span className="hidden sm:inline">Meta de ROAS</span>
          <span className="sm:hidden">Meta</span> {fmt.roas(target)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <div>
          <p className="text-sm font-medium text-foreground">Meta de ROAS</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Verde a partir da meta, amarelo entre 1x e a meta, vermelho abaixo de 1x. Fica salva
            neste aparelho.
          </p>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            inputMode="decimal"
            aria-label="Meta de ROAS"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^\d,.]/g, ""))}
          />
          <Button type="submit">Salvar</Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function Thumb({
  src,
  alt,
  size = "md",
}: {
  src: string | null;
  alt: string;
  size?: "sm" | "md" | "lg";
}) {
  const [failed, setFailed] = useState(false);
  const box = size === "sm" ? "h-8 w-8" : size === "lg" ? "h-16 w-16" : "h-10 w-10";
  if (!src || failed) {
    return (
      <span
        className={cn(
          box,
          "flex shrink-0 items-center justify-center rounded-md border border-border bg-surface-muted text-muted-foreground",
        )}
      >
        <ImageOff className="h-4 w-4" aria-hidden />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn(box, "shrink-0 rounded-md border border-border bg-surface-muted object-cover")}
    />
  );
}

export function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-medium text-muted-foreground">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
      </span>
      Ao vivo
    </span>
  );
}

const chartConfig = {
  revenueCents: { label: "Faturamento", color: "var(--chart-1)" },
  spendCents: { label: "Gasto", color: "var(--chart-4)" },
} satisfies ChartConfig;

/** Faturamento (barras) e gasto (linha) no mesmo eixo em reais. */
export function SpendRevenueChart({
  points,
  mode,
  currency,
  showSpend,
}: {
  points: DailyPoint[];
  mode: "day" | "hour";
  currency: string;
  showSpend: boolean;
}) {
  const spend = showSpend && mode === "day";
  const dense = points.length > 14;
  if (points.every((p) => p.revenueCents === 0 && (!spend || p.spendCents === 0))) {
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-1 px-6 text-center sm:h-64 lg:h-[19rem]">
        <p className="text-sm font-medium text-foreground">Nada no período ainda</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          {spend
            ? "O gasto e o faturamento de cada dia aparecem aqui."
            : "O faturamento de cada dia aparece aqui assim que as vendas chegarem."}
        </p>
      </div>
    );
  }
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
        {spend && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded-full bg-chart-4" />
            Gasto
          </span>
        )}
      </div>
      <ChartContainer
        config={chartConfig}
        className="aspect-auto h-56 w-full px-1 pb-2 sm:h-64 lg:h-[19rem]"
      >
        <ComposedChart
          data={points}
          margin={{ top: 12, right: 12, bottom: 0, left: 4 }}
          barCategoryGap={dense ? "18%" : "28%"}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={mode === "hour" ? 12 : 8}
            interval="preserveStartEnd"
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={64}
            tickFormatter={(v: number) => fmt.compactMoney(v, currency)}
          />
          <Tooltip
            cursor={{ fill: "var(--surface-hover)" }}
            content={({ active, payload }) => {
              const p = active && (payload?.[0]?.payload as DailyPoint | undefined);
              if (!p) return null;
              const roas = p.spendCents > 0 ? p.revenueCents / p.spendCents : null;
              return (
                <div className="min-w-44 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-md">
                  <p className="mb-1.5 font-medium text-foreground">
                    {mode === "hour"
                      ? `${p.label} – ${p.label.replace("h", "")}h59`
                      : p.key.split("-").reverse().join("/")}
                  </p>
                  <TooltipRow
                    color="bg-chart-1"
                    label="Faturamento"
                    value={formatMoney(p.revenueCents, currency)}
                  />
                  {spend && (
                    <TooltipRow
                      color="bg-chart-4"
                      label="Gasto"
                      value={formatMoney(p.spendCents, currency)}
                    />
                  )}
                  <div className="mt-1.5 flex justify-between gap-4 border-t border-border pt-1.5 text-muted-foreground">
                    <span>{p.sales === 1 ? "1 venda" : `${fmt.int(p.sales)} vendas`}</span>
                    {spend && <span className="tabular-nums">ROAS {fmt.roas(roas)}</span>}
                  </div>
                </div>
              );
            }}
          />
          <Bar
            dataKey="revenueCents"
            fill="var(--color-revenueCents)"
            radius={[4, 4, 0, 0]}
            maxBarSize={36}
          />
          {spend && (
            <Line
              dataKey="spendCents"
              type="monotone"
              stroke="var(--color-spendCents)"
              strokeWidth={2}
              dot={
                points.length <= 14
                  ? {
                      r: 3,
                      fill: "var(--color-spendCents)",
                      stroke: "var(--surface)",
                      strokeWidth: 2,
                    }
                  : false
              }
              activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }}
            />
          )}
        </ComposedChart>
      </ChartContainer>
    </div>
  );
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className={cn("h-2 w-2 rounded-sm", color)} />
        {label}
      </span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}
