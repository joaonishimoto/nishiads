import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ExternalLink,
  ImageOff,
  LayoutGrid,
  List,
  Search,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Status, type Tone } from "@/components/app/ui";
import { readLocal, writeLocal } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { derived, type NodeMetrics } from "@/features/results/metrics";
import { fmt, RoasBadge, Thumb } from "@/features/results/components";
import { DELIVERY_LABELS } from "@/features/results/campaign-tree";
import type { CreativeItem } from "@/features/results/campaign-visuals";
import {
  averageCpa,
  creative,
  registrationsOf,
  verdictOf,
  type Verdict,
} from "@/features/results/creative-insights";
import { DeliveryToggle } from "@/features/meta/controls";

/** 12,3 mil: contagens grandes cabem no funil do cartão. */
const compact = (n: number) =>
  n < 10_000
    ? fmt.int(n)
    : new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(n);

const VERDICTS: Record<Verdict, { label: string; tone: Tone; hint: (ctx: Ctx) => string }> = {
  scale: {
    label: "Escalar",
    tone: "success",
    hint: (c) => `ROAS na meta de ${fmt.roas(c.target)}: candidato a mais orçamento`,
  },
  watch: {
    label: "Abaixo da meta",
    tone: "warning",
    hint: (c) => `Paga o gasto, mas o ROAS está abaixo da meta de ${fmt.roas(c.target)}`,
  },
  loss: {
    label: "No prejuízo",
    tone: "danger",
    hint: () => "ROAS abaixo de 1x: fatura menos do que gasta",
  },
  pause: {
    label: "Pausar?",
    tone: "danger",
    hint: (c) =>
      `Já gastou mais que o CPA médio dos criativos (${fmt.money(c.avgCpa, c.currency)}) sem nenhuma venda`,
  },
  learning: {
    label: "Sem venda ainda",
    tone: "neutral",
    hint: (c) =>
      c.avgCpa === null
        ? "Nenhuma venda nos criativos ainda"
        : `Gastou menos que o CPA médio (${fmt.money(c.avgCpa, c.currency)}): ainda cedo para julgar`,
  },
  idle: { label: "Sem gasto", tone: "neutral", hint: () => "Sem gasto no período" },
};

type Ctx = {
  currency: string;
  target: number;
  avgCpa: number | null;
  totalSpend: number;
  totalRevenue: number;
};

type Row = CreativeItem & { verdict: Verdict };

type CreativeSort =
  "profit" | "roas" | "revenue" | "spend" | "sales" | "registrations" | "ctr" | "cpa" | "cpl";
const SORTS: {
  key: CreativeSort;
  label: string;
  /** Menor primeiro (custos). */
  asc?: boolean;
  value: (m: NodeMetrics) => number | null;
}[] = [
  { key: "profit", label: "Maior lucro", value: derived.profit },
  { key: "roas", label: "Maior ROAS", value: derived.roas },
  { key: "revenue", label: "Maior faturamento", value: (m) => m.revenueCents },
  { key: "spend", label: "Maior gasto", value: (m) => m.spendCents },
  { key: "sales", label: "Mais vendas", value: (m) => m.sales },
  { key: "registrations", label: "Mais cadastros", value: (m) => registrationsOf(m).count },
  { key: "ctr", label: "Maior CTR", value: derived.ctr },
  { key: "cpa", label: "Menor CPA", asc: true, value: derived.cpa },
  { key: "cpl", label: "Menor custo por cadastro", asc: true, value: creative.costPerRegistration },
];

type CreativeFilter = "all" | "active" | "scale" | "profit" | "loss" | "nosale";
const FILTERS: { key: CreativeFilter; label: string; match: (r: Row) => boolean }[] = [
  { key: "all", label: "Todos", match: () => true },
  { key: "active", label: "Ativos", match: (r) => r.node.status === "ACTIVE" },
  { key: "scale", label: "Para escalar", match: (r) => r.verdict === "scale" },
  { key: "profit", label: "Dando lucro", match: (r) => derived.profit(r.node.metrics) > 0 },
  { key: "loss", label: "No prejuízo", match: (r) => derived.profit(r.node.metrics) < 0 },
  {
    key: "nosale",
    label: "Sem venda",
    match: (r) => r.node.metrics.sales === 0 && r.node.metrics.spendCents > 0,
  },
];

type ViewMode = "cards" | "list";
const VIEW_KEY = "nishiads:criativos-visao";

/** Aba Criativos: resumo, filtros e cada anúncio em cartão ou lista. */
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
  const [query, setQuery] = useState("");
  const [view, setViewState] = useState<ViewMode>(() =>
    readLocal(VIEW_KEY) === "list" ? "list" : "cards",
  );
  const setView = (v: ViewMode) => {
    setViewState(v);
    writeLocal(VIEW_KEY, v);
  };

  const ctx = useMemo<Ctx>(() => {
    const all = items.map((i) => i.node.metrics);
    return {
      currency,
      target,
      avgCpa: averageCpa(all),
      totalSpend: all.reduce((n, m) => n + m.spendCents, 0),
      totalRevenue: all.reduce((n, m) => n + m.revenueCents, 0),
    };
  }, [items, currency, target]);

  const rows = useMemo<Row[]>(
    () => items.map((i) => ({ ...i, verdict: verdictOf(i.node.metrics, target, ctx.avgCpa) })),
    [items, target, ctx.avgCpa],
  );

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.key, rows.filter(f.match).length])),
    [rows],
  );

  const shown = useMemo(() => {
    const s = SORTS.find((x) => x.key === sort)!;
    const match = FILTERS.find((f) => f.key === filter)!.match;
    const q = query.trim().toLowerCase();
    return rows
      .filter(match)
      .filter(
        (r) =>
          !q ||
          r.node.name.toLowerCase().includes(q) ||
          r.campaign.toLowerCase().includes(q) ||
          r.adset.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const va = s.value(a.node.metrics);
        const vb = s.value(b.node.metrics);
        // Sem valor (ex.: CPA sem venda) vai para o fim nos dois sentidos.
        if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
        return s.asc ? va - vb : vb - va;
      });
  }, [rows, sort, filter, query]);

  return (
    <div className="space-y-4">
      <CreativesSummary rows={rows} ctx={ctx} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar criativo"
            aria-label="Buscar criativo"
            className="h-8 pl-8 pr-8 text-sm"
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
        <div
          className="flex rounded-md border border-border bg-muted p-0.5"
          role="group"
          aria-label="Modo de exibição"
        >
          {(
            [
              { key: "cards", label: "Cartões", icon: LayoutGrid },
              { key: "list", label: "Lista", icon: List },
            ] as const
          ).map((v) => (
            <button
              key={v.key}
              type="button"
              aria-pressed={view === v.key}
              aria-label={v.label}
              title={v.label}
              onClick={() => setView(v.key)}
              className={cn(
                "flex h-7 w-8 items-center justify-center rounded-[5px] transition-colors",
                view === v.key
                  ? "bg-surface text-primary shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <v.icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      </div>

      <div
        className="-mt-1 flex gap-1.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
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

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong px-4 py-10 text-center text-sm text-muted-foreground">
          {query
            ? `Nenhum criativo com "${query.trim()}" nesse filtro.`
            : "Nenhum criativo nesse filtro."}
        </p>
      ) : view === "cards" ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((r) => (
            <CreativeCard key={r.node.id} row={r} ctx={ctx} />
          ))}
        </ul>
      ) : (
        <CreativeList rows={shown} ctx={ctx} />
      )}
    </div>
  );
}

/** Faixa de números do conjunto de criativos: onde está o lucro e onde o gasto vaza. */
function CreativesSummary({ rows, ctx }: { rows: Row[]; ctx: Ctx }) {
  const active = rows.filter((r) => r.node.status === "ACTIVE").length;
  const profit = rows.reduce((n, r) => n + derived.profit(r.node.metrics), 0);
  const winners = rows.filter((r) => derived.profit(r.node.metrics) > 0).length;
  const losers = rows.filter((r) => derived.profit(r.node.metrics) < 0).length;
  const scale = rows.filter((r) => r.verdict === "scale");
  const noSale = rows.filter((r) => r.node.metrics.sales === 0 && r.node.metrics.spendCents > 0);
  const wasted = noSale.reduce((n, r) => n + r.node.metrics.spendCents, 0);
  const best = [...rows].sort(
    (a, b) => derived.profit(b.node.metrics) - derived.profit(a.node.metrics),
  )[0];
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border xl:grid-cols-4">
      <SummaryTile
        label="Criativos"
        value={fmt.int(rows.length)}
        hint={`${fmt.int(active)} ${active === 1 ? "ativo" : "ativos"} · CPA médio ${fmt.money(ctx.avgCpa, ctx.currency)}`}
      />
      <SummaryTile
        label="Lucro somado"
        value={fmt.money(profit, ctx.currency)}
        tone={profit < 0 ? "danger" : profit > 0 ? "success" : undefined}
        hint={`${fmt.int(winners)} dando lucro · ${fmt.int(losers)} no prejuízo`}
      />
      <SummaryTile
        label="Para escalar"
        value={fmt.int(scale.length)}
        tone={scale.length > 0 ? "success" : undefined}
        hint={
          best && derived.profit(best.node.metrics) > 0
            ? `Melhor: ${best.node.name}`
            : `ROAS na meta de ${fmt.roas(ctx.target)}`
        }
      />
      <SummaryTile
        label="Gasto sem venda"
        value={fmt.money(wasted, ctx.currency)}
        tone={wasted > 0 ? "danger" : undefined}
        hint={
          noSale.length === 0
            ? "Todo criativo com gasto vendeu"
            : `${fmt.int(noSale.length)} ${noSale.length === 1 ? "criativo" : "criativos"} · ${fmt.pct(ctx.totalSpend > 0 ? wasted / ctx.totalSpend : null)} do gasto`
        }
      />
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "success" | "danger";
}) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3.5">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1.5 text-lg font-semibold tracking-[-0.02em] tabular-nums [overflow-wrap:anywhere] sm:text-[22px] sm:leading-7",
          tone === "success"
            ? "text-success-strong"
            : tone === "danger"
              ? "text-danger-strong"
              : "text-foreground",
        )}
      >
        {value}
      </p>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={hint}>
        {hint}
      </p>
    </div>
  );
}

function VerdictChip({ verdict, ctx }: { verdict: Verdict; ctx: Ctx }) {
  const v = VERDICTS[verdict];
  return (
    <span title={v.hint(ctx)}>
      <Status tone={v.tone}>{v.label}</Status>
    </span>
  );
}

function statusLabel(status: string | null) {
  return DELIVERY_LABELS[status ?? ""] ?? status ?? "Sem status";
}

/** Miniatura grande: o criativo inteiro sobre um fundo desfocado dele mesmo. */
function CreativeMedia({ row, ctx }: { row: Row; ctx: Ctx }) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : row.node.thumbnailUrl;
  const active = row.node.status === "ACTIVE";
  return (
    <div className="relative h-44 overflow-hidden border-b border-border bg-surface-muted">
      {src ? (
        <>
          <img
            src={src}
            alt=""
            aria-hidden
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-xl"
          />
          <img
            src={src}
            alt={`Criativo ${row.node.name}`}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="relative mx-auto h-full w-auto max-w-full object-contain"
          />
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
          <ImageOff className="h-5 w-5" aria-hidden />
          <span className="text-xs">Sem miniatura</span>
        </div>
      )}
      <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/90 px-2 py-0.5 text-[11px] font-medium text-foreground backdrop-blur-sm">
        <span
          className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-success" : "bg-border-strong")}
        />
        {statusLabel(row.node.status)}
      </span>
      <span className="absolute right-2.5 top-2.5 rounded-[6px] bg-surface/90 backdrop-blur-sm">
        <VerdictChip verdict={row.verdict} ctx={ctx} />
      </span>
      {row.node.previewLink && (
        <a
          href={row.node.previewLink}
          target="_blank"
          rel="noreferrer"
          className="absolute bottom-2.5 right-2.5 inline-flex items-center gap-1 rounded-full border border-border bg-surface/90 px-2.5 py-1 text-[11px] font-medium text-primary backdrop-blur-sm hover:bg-surface"
        >
          Ver anúncio
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

function CreativeCard({ row, ctx }: { row: Row; ctx: Ctx }) {
  const m = row.node.metrics;
  const profit = derived.profit(m);
  const reg = registrationsOf(m);
  const hook = creative.hookRate(m);
  const landing = creative.landingRate(m);
  const engagement = creative.engagement(m);
  const spendShare = ctx.totalSpend > 0 ? m.spendCents / ctx.totalSpend : null;
  const revenueShare = ctx.totalRevenue > 0 ? m.revenueCents / ctx.totalRevenue : null;
  const extras: { label: string; value: string; hint: string }[] = [];
  if (hook !== null && hook > 0)
    extras.push({
      label: "Retenção 3s",
      value: fmt.pct(hook, 1),
      hint: "visualizações de 3 segundos ÷ impressões: quanto o começo do vídeo segura",
    });
  if (landing !== null && landing > 0)
    extras.push({
      label: "Na página",
      value: fmt.pct(Math.min(landing, 1)),
      hint: "visualizações da página ÷ cliques no link",
    });
  if (engagement > 0)
    extras.push({
      label: "Engajamento",
      value: compact(engagement),
      hint: "todas as interações com o anúncio",
    });
  if (m.trials > 0)
    extras.push({ label: "Testes", value: fmt.int(m.trials), hint: "testes grátis iniciados" });

  return (
    <li
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-surface transition-shadow hover:shadow-sm",
        profit < 0 ? "border-danger/25" : profit > 0 ? "border-success/25" : "border-border",
      )}
    >
      <CreativeMedia row={row} ctx={ctx} />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <div className="flex items-start justify-between gap-2">
            <p
              className="line-clamp-2 text-sm font-semibold leading-5 text-foreground"
              title={row.node.name}
            >
              {row.node.name}
            </p>
            <DeliveryToggle node={row.node} ancestors={row.ancestors} />
          </div>
          <p
            className="mt-0.5 truncate text-xs text-muted-foreground"
            title={`${row.campaign} › ${row.adset}`}
          >
            {row.campaign} › {row.adset}
          </p>
        </div>

        <div className="rounded-lg bg-surface-muted px-3 py-2.5">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
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
                {fmt.money(profit, ctx.currency)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] text-muted-foreground">ROAS</p>
              <RoasBadge roas={derived.roas(m)} target={ctx.target} className="text-base" />
            </div>
          </div>
          <SpendRevenueBars m={m} currency={ctx.currency} />
        </div>

        <Funnel
          steps={[
            { label: "Impressões", value: compact(m.impressions) },
            {
              label: "Cliques",
              value: compact(m.linkClicks),
              rate: derived.ctr(m),
              rateHint: "CTR: cliques no link ÷ impressões",
              rateLabel: "CTR",
            },
            {
              label: "Cadastros",
              value: reg.source ? compact(reg.count) : "—",
              rate: reg.source ? creative.registrationRate(m) : null,
              rateHint:
                reg.source === "rastreio"
                  ? "cadastros do rastreamento próprio ÷ cliques"
                  : "cadastros atribuídos pela Meta ÷ cliques",
              title:
                reg.source === "rastreio"
                  ? "Do rastreamento próprio (nishistack('cadastro'))"
                  : reg.source === "meta"
                    ? "Atribuídos pela Meta"
                    : "Nenhum cadastro registrado",
            },
            {
              label: "Vendas",
              value: fmt.int(m.sales),
              rate: creative.saleRate(m),
              rateHint: "vendas aprovadas ÷ cliques no link",
            },
          ]}
        />

        <dl className="grid grid-cols-4 gap-x-2 gap-y-2 text-xs">
          <Cell label="Gasto" value={fmt.money(m.spendCents, ctx.currency)} />
          <Cell label="CPA" value={fmt.money(derived.cpa(m), ctx.currency)} hint="gasto ÷ vendas" />
          <Cell
            label="Custo/cad."
            value={fmt.money(creative.costPerRegistration(m), ctx.currency)}
            hint="gasto ÷ cadastros"
          />
          <Cell
            label="CPC"
            value={fmt.money(derived.cpc(m), ctx.currency)}
            hint="custo por clique no link"
          />
          <Cell
            label="CPM"
            value={fmt.money(creative.cpm(m), ctx.currency)}
            hint="custo por mil impressões"
          />
          <Cell
            label="Ticket"
            value={fmt.money(
              m.sales > 0 ? Math.round(m.revenueCents / m.sales) : null,
              ctx.currency,
            )}
            hint="faturamento ÷ vendas"
          />
          {extras.slice(0, 2).map((e) => (
            <Cell key={e.label} label={e.label} value={e.value} hint={e.hint} />
          ))}
        </dl>

        {(spendShare !== null || revenueShare !== null) && (
          <p className="mt-auto border-t border-border pt-2.5 text-[11px] text-muted-foreground">
            Leva <span className="font-medium text-foreground">{fmt.pct(spendShare)}</span> do gasto
            e traz <span className="font-medium text-foreground">{fmt.pct(revenueShare)}</span> do
            faturamento dos criativos
          </p>
        )}
      </div>
    </li>
  );
}

/** Faturamento contra gasto na mesma escala: a barra de cima precisa passar a de baixo. */
function SpendRevenueBars({ m, currency }: { m: NodeMetrics; currency: string }) {
  const max = Math.max(1, m.spendCents, m.revenueCents);
  const w = (v: number) => `${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%`;
  return (
    <div className="mt-2.5 grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-[11px]">
      <span className="text-muted-foreground">Faturamento</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
        <div className="h-full rounded-full bg-chart-1" style={{ width: w(m.revenueCents) }} />
      </div>
      <span className="text-right tabular-nums text-foreground">
        {fmt.money(m.revenueCents, currency)}
      </span>
      <span className="text-muted-foreground">Gasto</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
        <div className="h-full rounded-full bg-chart-4" style={{ width: w(m.spendCents) }} />
      </div>
      <span className="text-right tabular-nums text-muted-foreground">
        {fmt.money(m.spendCents, currency)}
      </span>
    </div>
  );
}

function Funnel({
  steps,
}: {
  steps: {
    label: string;
    value: string;
    rate?: number | null;
    rateLabel?: string;
    rateHint?: string;
    title?: string;
  }[];
}) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Funil
      </p>
      <ol className="grid grid-cols-4 overflow-hidden rounded-lg border border-border">
        {steps.map((s, i) => (
          <li
            key={s.label}
            className={cn("relative min-w-0 py-2 pl-3 pr-2", i > 0 && "border-l border-border")}
            title={s.title}
          >
            {i > 0 && (
              <ArrowRight
                className="absolute -left-[7px] top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-surface text-muted-foreground"
                aria-hidden
              />
            )}
            <p className="truncate text-[11px] text-muted-foreground">{s.label}</p>
            <p className="truncate text-sm font-semibold tabular-nums text-foreground">{s.value}</p>
            <p
              className="truncate text-[11px] tabular-nums text-muted-foreground"
              title={s.rateHint}
            >
              {i === 0
                ? " "
                : `${s.rateLabel ? `${s.rateLabel} ` : ""}${fmt.pct(s.rate ?? null, 1)}`}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Cell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums text-foreground [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

/** Todos os criativos numa tabela compacta, para comparar lado a lado. */
function CreativeList({ rows, ctx }: { rows: Row[]; ctx: Ctx }) {
  const head = (label: string, hint?: string): ReactNode => (
    <th
      scope="col"
      title={hint}
      className="whitespace-nowrap px-3 py-2 text-right text-xs font-medium text-muted-foreground"
    >
      {label}
    </th>
  );
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full min-w-[920px] text-sm">
        <thead className="border-b border-border bg-surface-muted/60">
          <tr>
            <th
              scope="col"
              className="px-3 py-2 text-left text-xs font-medium text-muted-foreground"
            >
              Criativo
            </th>
            {head("Gasto")}
            {head("Lucro", "faturamento − taxas − custos − gasto")}
            {head("ROAS", "faturamento ÷ gasto")}
            {head("Vendas")}
            {head("CPA", "gasto ÷ vendas")}
            {head("Cadastros")}
            {head("Custo/cad.", "gasto ÷ cadastros")}
            {head("CTR", "cliques no link ÷ impressões")}
            {head("CPC", "custo por clique no link")}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => {
            const m = r.node.metrics;
            const profit = derived.profit(m);
            const reg = registrationsOf(m);
            return (
              <tr key={r.node.id} className="hover:bg-surface-hover/60">
                <td className="max-w-[340px] px-3 py-2">
                  <div className="flex items-center gap-3">
                    <span className="relative shrink-0">
                      <Thumb src={r.node.thumbnailUrl} alt="" />
                      <span
                        className={cn(
                          "absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface",
                          r.node.status === "ACTIVE" ? "bg-success" : "bg-border-strong",
                        )}
                        title={statusLabel(r.node.status)}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate font-medium text-foreground" title={r.node.name}>
                          {r.node.name}
                        </p>
                        {r.node.previewLink && (
                          <a
                            href={r.node.previewLink}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Ver anúncio ${r.node.name}`}
                            className="shrink-0 text-muted-foreground hover:text-primary"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <VerdictChip verdict={r.verdict} ctx={ctx} />
                        <p
                          className="truncate text-xs text-muted-foreground"
                          title={`${r.campaign} › ${r.adset}`}
                        >
                          {r.campaign} › {r.adset}
                        </p>
                      </div>
                    </div>
                    <DeliveryToggle node={r.node} ancestors={r.ancestors} />
                  </div>
                </td>
                <Num>{fmt.money(m.spendCents, ctx.currency)}</Num>
                <Num
                  className={cn(
                    "font-semibold",
                    profit < 0
                      ? "text-danger-strong"
                      : profit > 0
                        ? "text-success-strong"
                        : "text-muted-foreground",
                  )}
                >
                  {fmt.money(profit, ctx.currency)}
                </Num>
                <Num>
                  <RoasBadge roas={derived.roas(m)} target={ctx.target} />
                </Num>
                <Num>{fmt.int(m.sales)}</Num>
                <Num>{fmt.money(derived.cpa(m), ctx.currency)}</Num>
                <Num>{reg.source ? fmt.int(reg.count) : "—"}</Num>
                <Num>{fmt.money(creative.costPerRegistration(m), ctx.currency)}</Num>
                <Num>{fmt.pct(derived.ctr(m), 2)}</Num>
                <Num>{fmt.money(derived.cpc(m), ctx.currency)}</Num>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Num({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <td
      className={cn(
        "whitespace-nowrap px-3 py-2 text-right tabular-nums text-foreground",
        className,
      )}
    >
      {children}
    </td>
  );
}
