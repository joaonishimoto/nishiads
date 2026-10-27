import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  ArrowUp,
  Check,
  CircleDollarSign,
  CirclePause,
  CirclePlay,
  History,
  Plug,
  RotateCcw,
  Sparkles,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { LoadError, PageHeader, PageSkeleton, Panel, Status } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { MetaControlsProvider, formatBudget, useMetaControls } from "@/features/meta/controls";
import { FilterBar, useResultFilters } from "@/features/results/filters";
import { useResults } from "@/features/results/use-results";
import { useRoasTarget } from "@/features/results/components";
import type { TreeNode } from "@/features/results/metrics";
import { buildAssistantContext, findInTree } from "@/features/assistant/context";
import { useAssistantChat, type ChatMessage, type Proposal } from "@/features/assistant/api";
import { Markdown } from "@/features/assistant/markdown";
import { PERIOD_LABELS } from "@/lib/period";
import { cn } from "@/lib/utils";

const STARTERS = [
  "Como foram minhas campanhas nesse período?",
  "Quais anúncios eu deveria pausar?",
  "Onde vale a pena aumentar o orçamento?",
  "Por que o resultado mudou em relação ao período anterior?",
  "Quais criativos estão funcionando melhor e o que testar a seguir?",
];

export function AssistantPage() {
  const { workspace } = useWorkspace();
  return (
    <MetaControlsProvider currency={workspace.currency}>
      <AssistantContent />
    </MetaControlsProvider>
  );
}

function AssistantContent() {
  const { workspace } = useWorkspace();
  const base = `/w/${workspace.id}`;
  const filters = useResultFilters();
  const chat = useAssistantChat(workspace.id);
  // Objetos sugeridos ficam na árvore mesmo sem gasto no período (ex.: acabou de pausar).
  const suggested = useMemo(
    () =>
      new Set(
        (chat.conversation?.messages ?? []).flatMap((m) => m.proposals.map((p) => p.id)),
      ) as ReadonlySet<string>,
    [chat.conversation],
  );
  const results = useResults(filters, { tree: true, keep: suggested });
  const [target] = useRoasTarget(workspace.id);

  const scope = [
    filters.period,
    filters.days.first,
    filters.days.last,
    filters.accountId ?? "",
    filters.productId ?? "",
  ].join("|");
  const c = results.computed;
  const fresh = useMemo(() => {
    if (!c) return null;
    return {
      scope,
      context: buildAssistantContext({
        currency: workspace.currency,
        timezone: workspace.timezone,
        period: {
          label: PERIOD_LABELS[filters.period],
          first: filters.days.first,
          last: filters.days.last,
          comparison: filters.comparisonLabel,
        },
        account: results.tracked.find((a) => a.id === filters.accountId)?.name ?? null,
        product: results.products.find((p) => p.id === filters.productId)?.name ?? null,
        lastSync: results.lastSync,
        roasTarget: target,
        totals: c.totals,
        previous: c.previous,
        series: c.series.points,
        tree: c.tree ?? [],
        products: results.products,
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, scope, target, results.lastSync, results.products, results.tracked]);

  const header = (
    <PageHeader
      title="Assistente"
      subtitle="Pergunte sobre gasto, ROAS, CPA e lucro das campanhas. Ele explica os números do período e sugere mudanças que você confirma antes de aplicar."
      actions={
        chat.conversation && (
          <Button variant="outline" onClick={chat.reset}>
            <RotateCcw />
            Nova conversa
          </Button>
        )
      }
    />
  );

  if (results.isPending && !c) return <PageSkeleton variant="table" />;

  const conversation = chat.conversation;
  const stale = conversation && conversation.scope !== scope;
  const ask = (text: string) => {
    if (fresh) void chat.send(text, fresh);
  };

  return (
    <div className="space-y-5">
      {header}
      <FilterBar
        filters={filters}
        accounts={results.tracked.map((a) => ({ id: a.id, name: a.name }))}
        products={results.products}
      />

      {results.isError && (
        <LoadError onRetry={results.retry} retrying={results.isFetching}>
          Não foi possível carregar parte dos dados. O assistente pode ver números incompletos.
        </LoadError>
      )}

      {!results.metaConnected && (
        <Panel>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-primary">
                <Plug className="h-4 w-4" />
              </span>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Sem a Meta Ads conectada</span>, o
                assistente só enxerga as vendas. Conecte para ele analisar gasto, ROAS e criativos.
              </p>
            </div>
            <Button asChild variant="outline" className="shrink-0">
              <Link to={`${base}/integracoes`}>Conectar Meta Ads</Link>
            </Button>
          </div>
        </Panel>
      )}

      {stale && (
        <p className="flex flex-col gap-2 rounded-lg bg-info/10 px-3 py-2 text-sm text-info-strong sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-start gap-2">
            <History className="mt-0.5 h-4 w-4 shrink-0" />
            Esta conversa usa os números de {conversation.context.periodo.rotulo.toLowerCase()} (
            {formatDay(conversation.context.periodo.de)} a{" "}
            {formatDay(conversation.context.periodo.ate)}). Para analisar o recorte atual, comece
            uma nova conversa.
          </span>
          <Button size="sm" variant="outline" className="shrink-0 bg-surface" onClick={chat.reset}>
            Nova conversa
          </Button>
        </p>
      )}

      <Panel className="flex flex-col">
        <Messages
          messages={conversation?.messages ?? []}
          streaming={chat.streaming}
          thinking={chat.thinking}
          tree={c?.tree ?? []}
          onAsk={ask}
          ready={!!fresh}
        />
        <Composer disabled={!fresh} streaming={chat.streaming} onSend={ask} onStop={chat.stop} />
      </Panel>
      <p className="text-center text-xs text-muted-foreground">
        O assistente usa IA e pode errar. Confira os números antes de mudar campanhas; nada é
        alterado na Meta sem a sua confirmação.
      </p>
    </div>
  );
}

function formatDay(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}

function Messages({
  messages,
  streaming,
  thinking,
  tree,
  onAsk,
  ready,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  thinking: boolean;
  tree: TreeNode[];
  onAsk: (text: string) => void;
  ready: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const last = messages.at(-1);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.content, last?.proposals.length]);

  return (
    <div
      ref={scroller}
      className="h-[calc(100dvh-26rem)] min-h-80 overflow-y-auto px-4 py-4"
      aria-live="polite"
    >
      {messages.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-primary">
            <Sparkles className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <h2 className="mt-3 text-sm font-semibold text-foreground">
            O que você quer entender das campanhas?
          </h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            O assistente lê os números do período e dos filtros acima. Comece por uma destas
            perguntas ou escreva a sua.
          </p>
          <div className="mt-4 flex max-w-xl flex-wrap justify-center gap-2">
            {STARTERS.map((s) => (
              <Button
                key={s}
                variant="outline"
                size="sm"
                className="h-auto whitespace-normal py-1.5 text-left"
                disabled={!ready}
                onClick={() => onAsk(s)}
              >
                {s}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-accent px-3 py-2 text-sm text-foreground">
                  {m.content}
                </p>
              </div>
            ) : (
              <div key={m.id} className="flex gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-primary">
                  <Sparkles className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1 space-y-3">
                  {m.content ? (
                    <Markdown text={m.content} />
                  ) : (
                    streaming &&
                    m === last &&
                    thinking && (
                      <p className="animate-pulse text-sm text-muted-foreground">
                        Analisando os números…
                      </p>
                    )
                  )}
                  {m.proposals.length > 0 && (
                    <div className="space-y-2">
                      {m.proposals.map((p, i) => (
                        <ProposalCard key={`${p.id}-${i}`} proposal={p} tree={tree} />
                      ))}
                    </div>
                  )}
                  {m.error && (
                    <p className="rounded-md bg-danger/8 px-3 py-2 text-sm text-danger-strong">
                      {m.error}
                    </p>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

const NOUN = { campaign: "campanha", adset: "conjunto", ad: "anúncio" } as const;

function ProposalCard({ proposal: p, tree }: { proposal: Proposal; tree: TreeNode[] }) {
  const { workspace } = useWorkspace();
  const controls = useMetaControls();
  const found = findInTree(tree, p.id);
  const node = found?.node;
  const currency = workspace.currency;
  const block = node && controls ? controls.block(node.accountId) : null;
  const pending = !!controls?.pending.has(p.id);

  const Icon =
    p.action === "pause" ? CirclePause : p.action === "activate" ? CirclePlay : CircleDollarSign;
  const title =
    p.action === "set_budget"
      ? `Orçamento ${p.level === "campaign" ? "da campanha" : "do conjunto"}`
      : `${p.action === "pause" ? "Pausar" : "Ativar"} ${NOUN[p.level]}`;
  const suggestedBudget =
    p.budget_cents !== null && p.budget_kind
      ? formatBudget({ kind: p.budget_kind, cents: p.budget_cents }, currency)
      : null;

  const done = node
    ? p.action === "set_budget"
      ? node.budget?.cents === p.budget_cents
      : node.configuredStatus === (p.action === "pause" ? "PAUSED" : "ACTIVE")
    : false;

  let footer: ReactNode;
  if (!node) {
    footer = (
      <p className="text-xs text-muted-foreground">
        Não aparece no período e nos filtros atuais. Ajuste os filtros ou mude em Campanhas.
      </p>
    );
  } else if (done) {
    footer = (
      <Status tone="success">
        <Check />
        {p.action === "set_budget" ? "Aplicado" : p.action === "pause" ? "Pausado" : "Ativo"}
      </Status>
    );
  } else if (block === "viewer") {
    footer = <p className="text-xs text-muted-foreground">Só owners e admins aplicam mudanças.</p>;
  } else {
    footer = (
      <Button
        size="sm"
        variant={p.action === "pause" ? "outline" : "default"}
        loading={pending}
        onClick={() => {
          if (!controls || !found) return;
          if (p.action === "set_budget")
            controls.requestBudget(found.node, p.budget_cents ?? undefined);
          else controls.requestStatus(found.node, found.ancestors);
        }}
      >
        Revisar e {p.action === "pause" ? "pausar" : p.action === "activate" ? "ativar" : "aplicar"}
      </Button>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-surface-muted/40 p-3",
        done && "opacity-80",
      )}
    >
      <div className="flex gap-2.5">
        <Icon
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0",
            p.action === "pause" ? "text-danger-strong" : "text-primary",
          )}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium text-foreground">
            {title} <span className="break-words">“{p.name}”</span>
          </p>
          {p.action === "set_budget" && suggestedBudget && (
            <p className="text-sm tabular-nums text-muted-foreground">
              {node?.budget ? `${formatBudget(node.budget, currency)} → ` : ""}
              <span className="font-medium text-foreground">{suggestedBudget}</span>
            </p>
          )}
          <p className="text-sm text-muted-foreground">{p.reason}</p>
          <div className="pt-1">{footer}</div>
        </div>
      </div>
    </div>
  );
}

function Composer({
  disabled,
  streaming,
  onSend,
  onStop,
}: {
  disabled: boolean;
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const submit = () => {
    if (!text.trim() || streaming || disabled) return;
    onSend(text);
    setText("");
  };
  return (
    <form
      className="flex items-end gap-2 border-t border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Pergunte sobre as campanhas…"
        aria-label="Pergunta para o assistente"
        maxLength={4000}
        rows={1}
        className="max-h-40 min-h-10 resize-none"
      />
      {streaming ? (
        <Button type="button" size="icon" variant="outline" onClick={onStop} aria-label="Parar">
          <Square />
        </Button>
      ) : (
        <Button type="submit" size="icon" disabled={disabled || !text.trim()} aria-label="Enviar">
          <ArrowUp />
        </Button>
      )}
    </form>
  );
}
