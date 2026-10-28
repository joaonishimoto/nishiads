import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  ArrowUp,
  Check,
  CircleDollarSign,
  CirclePause,
  CirclePlay,
  History,
  MessageSquare,
  Plug,
  Plus,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { LoadError, PageHeader, PageSkeleton, Panel, Status } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { MetaControlsProvider, formatBudget, useMetaControls } from "@/features/meta/controls";
import { FilterBar, useResultFilters } from "@/features/results/filters";
import { useResults } from "@/features/results/use-results";
import { useRoasTarget } from "@/features/results/components";
import { timeAgo } from "@/features/results/recent-sales";
import type { TreeNode } from "@/features/results/metrics";
import { buildAssistantContext, findInTree } from "@/features/assistant/context";
import {
  AssistantError,
  isWriting,
  readLastConversation,
  useAsk,
  useConversation,
  useConversations,
  useDeleteConversation,
  useMessages,
  useStop,
  writeLastConversation,
  type ChatMessage,
  type ConversationSummary,
  type Proposal,
} from "@/features/assistant/api";
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
  const [target] = useRoasTarget(workspace.id);

  // Conversa aberta: a última usada, guardada no navegador; as mensagens ficam no banco.
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    readLastConversation(workspace.id),
  );
  const select = (id: string | null) => {
    setSelectedId(id);
    writeLastConversation(workspace.id, id);
  };
  const conversations = useConversations(workspace.id);
  const conversation = useConversation(selectedId);
  const messages = useMessages(selectedId);
  const ask = useAsk(workspace.id);
  const stop = useStop();
  const remove = useDeleteConversation(workspace.id);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Pergunta enviada enquanto a conversa nova ainda está sendo criada.
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);

  // Conversa apagada ou de outro workspace: volta para uma nova.
  useEffect(() => {
    if (selectedId && conversation.isSuccess && !conversation.data) select(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, conversation.isSuccess, conversation.data]);

  const list = messages.data ?? [];
  // Objetos sugeridos ficam na árvore mesmo sem gasto no período (ex.: acabou de pausar).
  const suggested = useMemo(
    () => new Set(list.flatMap((m) => m.proposals.map((p) => p.id))) as ReadonlySet<string>,
    [list],
  );
  const results = useResults(filters, { tree: true, keep: suggested });

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

  const writing = list.find((m) => isWriting(m)) ?? null;
  const busy = ask.isPending || !!writing;

  const send = (question: string) => {
    if (!fresh || busy) return;
    setPendingQuestion(question);
    ask.mutate(
      { question, conversationId: selectedId, fresh },
      {
        onSuccess: ({ conversation_id }) => {
          if (conversation_id !== selectedId) select(conversation_id);
        },
        onError: (error) =>
          toast.error(
            error instanceof AssistantError
              ? error.message
              : "Não foi possível falar com o assistente agora. Tente de novo.",
          ),
        onSettled: () => setPendingQuestion(null),
      },
    );
  };

  const historyList = (
    <ConversationList
      items={conversations.data ?? []}
      selectedId={selectedId}
      timezone={workspace.timezone}
      onSelect={(id) => {
        select(id);
        setHistoryOpen(false);
      }}
      onDelete={(id) =>
        remove.mutate(id, {
          onSuccess: () => {
            if (id === selectedId) select(null);
          },
          onError: () => toast.error("Não foi possível apagar a conversa."),
        })
      }
    />
  );

  const header = (
    <PageHeader
      title="Assistente"
      subtitle="Pergunte sobre gasto, ROAS, CPA e lucro das campanhas. Ele explica os números do período e sugere mudanças que você confirma antes de aplicar."
      actions={
        <>
          <Button variant="outline" className="lg:hidden" onClick={() => setHistoryOpen(true)}>
            <History />
            Histórico
          </Button>
          {selectedId && (
            <Button variant="outline" onClick={() => select(null)}>
              <Plus />
              Nova conversa
            </Button>
          )}
        </>
      }
    />
  );

  if (results.isPending && !c) return <PageSkeleton variant="table" />;

  const current = selectedId ? conversation.data : null;
  const stale = current && current.scope && current.scope !== scope;
  // Enquanto a pergunta vai para o servidor, ela já aparece na tela.
  const shown: ChatMessage[] =
    pendingQuestion && !list.some((m) => m.role === "user" && m.content === pendingQuestion)
      ? [...list, pendingMessage(pendingQuestion)]
      : list;

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
            Esta conversa usa os números de {current.context.periodo.rotulo.toLowerCase()} (
            {formatDay(current.context.periodo.de)} a {formatDay(current.context.periodo.ate)}).
            Para analisar o recorte atual, comece uma nova conversa.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 bg-surface"
            onClick={() => select(null)}
          >
            Nova conversa
          </Button>
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <Panel title="Histórico" className="hidden lg:block">
          {historyList}
        </Panel>
        <Panel className="flex min-w-0 flex-col">
          <Messages
            messages={shown}
            loading={!!selectedId && messages.isPending}
            tree={c?.tree ?? []}
            onAsk={send}
            ready={!!fresh}
          />
          <Composer
            disabled={!fresh}
            streaming={busy}
            onSend={send}
            onStop={() =>
              writing &&
              selectedId &&
              stop.mutate({ messageId: writing.id, conversationId: selectedId })
            }
          />
        </Panel>
      </div>
      <p className="text-center text-xs text-muted-foreground">
        O assistente usa IA e pode errar. Confira os números antes de mudar campanhas; nada é
        alterado na Meta sem a sua confirmação. Pode sair da tela: a resposta continua sendo escrita
        e fica no histórico.
      </p>

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" className="w-80 max-w-[85vw] p-0">
          <SheetHeader className="border-b border-border p-4">
            <SheetTitle>Histórico</SheetTitle>
            <SheetDescription>Suas conversas com o assistente neste workspace.</SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto">{historyList}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function pendingMessage(question: string): ChatMessage {
  const now = new Date().toISOString();
  return {
    id: "pendente",
    role: "user",
    content: question,
    proposals: [],
    status: "done",
    error: null,
    created_at: now,
    updated_at: now,
  };
}

function ConversationList({
  items,
  selectedId,
  timezone,
  onSelect,
  onDelete,
}: {
  items: ConversationSummary[];
  selectedId: string | null;
  timezone: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (items.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
        As conversas aparecem aqui.
      </p>
    );
  }
  return (
    <ul className="max-h-[calc(100dvh-22rem)] space-y-px overflow-y-auto p-2">
      {items.map((item) => (
        <li key={item.id} className="group relative">
          <button
            type="button"
            onClick={() => onSelect(item.id)}
            className={cn(
              "flex w-full items-start gap-2 rounded-md px-2 py-2 pr-9 text-left text-sm transition-colors hover:bg-surface-hover",
              item.id === selectedId && "bg-surface-selected",
            )}
          >
            <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="line-clamp-2 text-foreground">{item.title}</span>
              <span className="text-xs text-muted-foreground">
                {timeAgo(item.updated_at, timezone)}
              </span>
            </span>
          </button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Apagar conversa"
            className="absolute top-1.5 right-1 h-7 w-7 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100"
            onClick={() => {
              if (window.confirm("Apagar esta conversa?")) onDelete(item.id);
            }}
          >
            <Trash2 />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function formatDay(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}

function Messages({
  messages,
  loading,
  tree,
  onAsk,
  ready,
}: {
  messages: ChatMessage[];
  loading: boolean;
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
      {loading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Carregando a conversa…</p>
      ) : messages.length === 0 ? (
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
              <AssistantMessage key={m.id} message={m} tree={tree} />
            ),
          )}
          {last?.role === "user" && <Thinking />}
        </div>
      )}
    </div>
  );
}

function Thinking() {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-primary">
        <Sparkles className="h-3.5 w-3.5" />
      </span>
      <p className="animate-pulse pt-1 text-sm text-muted-foreground">Analisando os números…</p>
    </div>
  );
}

function AssistantMessage({ message: m, tree }: { message: ChatMessage; tree: TreeNode[] }) {
  const writing = isWriting(m);
  // "Escrevendo" sem novidade há muito tempo: a resposta caiu no meio.
  const dropped = m.status === "streaming" && !writing;
  if (writing && !m.content && m.proposals.length === 0) return <Thinking />;
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-primary">
        <Sparkles className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        {m.content && <Markdown text={m.content} />}
        {m.proposals.length > 0 && (
          <div className="space-y-2">
            {m.proposals.map((p, i) => (
              <ProposalCard key={`${p.id}-${i}`} proposal={p} tree={tree} />
            ))}
          </div>
        )}
        {writing && <p className="animate-pulse text-xs text-muted-foreground">Escrevendo…</p>}
        {m.status === "stopped" && (
          <p className="text-xs text-muted-foreground">Resposta interrompida por você.</p>
        )}
        {(m.status === "error" || dropped) && (
          <p className="rounded-md bg-danger/8 px-3 py-2 text-sm text-danger-strong">
            {m.error ?? "A resposta foi interrompida. Pergunte de novo."}
          </p>
        )}
      </div>
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
