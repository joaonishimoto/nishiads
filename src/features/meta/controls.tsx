import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { AlertTriangle, History, Pencil, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, LoadError } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { useAdAccounts, useMetaConnections } from "@/features/meta/api";
import {
  controlBlock,
  metaActionMessage,
  useMetaAction,
  useMetaActionLog,
  type ActionLogEntry,
  type ControlBlock,
  type MetaAction,
} from "@/features/meta/actions";
import type { Budget, Level, TreeNode } from "@/features/results/metrics";
import { formatDateTime, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

const NOUN: Record<Level, { one: string; the: string; done: (paused: boolean) => string }> = {
  campaign: {
    one: "campanha",
    the: "a campanha",
    done: (p) => (p ? "Campanha pausada" : "Campanha ativada"),
  },
  adset: {
    one: "conjunto",
    the: "o conjunto",
    done: (p) => (p ? "Conjunto pausado" : "Conjunto ativado"),
  },
  ad: {
    one: "anúncio",
    the: "o anúncio",
    done: (p) => (p ? "Anúncio pausado" : "Anúncio ativado"),
  },
};

/** Só ACTIVE e PAUSED se alternam; arquivado/excluído fica como está. */
export function canToggle(node: Pick<TreeNode, "configuredStatus">): boolean {
  return node.configuredStatus === "ACTIVE" || node.configuredStatus === "PAUSED";
}

/** Variação relativa entre dois orçamentos (0,2 = +20%). */
export function budgetChange(current: number, next: number): number | null {
  return current > 0 ? (next - current) / current : null;
}

/** Valor sugerido pelos atalhos de porcentagem, arredondado para o real inteiro. */
export function stepBudget(current: number, pct: number): number {
  return Math.max(100, Math.round((current * (1 + pct)) / 100) * 100);
}

export function formatBudget(budget: Budget, currency: string): string {
  return `${formatMoney(budget.cents, currency)}${budget.kind === "daily" ? "/dia" : " total"}`;
}

type StatusRequest = { node: TreeNode; ancestors: TreeNode[]; next: "ACTIVE" | "PAUSED" };

type Ctx = {
  block: (accountId: string) => ControlBlock | null;
  pending: ReadonlySet<string>;
  requestStatus: (node: TreeNode, ancestors: TreeNode[]) => void;
  requestBudget: (node: TreeNode) => void;
  currency: string;
};

const ControlsContext = createContext<Ctx | null>(null);
const TouchedContext = createContext<ReadonlySet<string> | undefined>(undefined);

/** Ids alterados nesta tela: a linha não some da tabela ao pausar algo sem gasto. */
export function useTouchedIds(): ReadonlySet<string> | undefined {
  return useContext(TouchedContext);
}

/** Sem provider (ex.: telas só de leitura), as chaves não aparecem. */
export function useMetaControls(): Ctx | null {
  return useContext(ControlsContext);
}

/**
 * Pausar, ativar e mudar orçamento: um diálogo de confirmação para a tela toda, estado
 * otimista (a chave muda na hora e volta se a Meta recusar) e "Desfazer" no aviso.
 */
export function MetaControlsProvider({
  children,
  currency,
}: {
  children: ReactNode;
  currency: string;
}) {
  const { workspace, canManage } = useWorkspace();
  const accounts = useAdAccounts(workspace.id);
  const connections = useMetaConnections(workspace.id);
  const { mutateAsync } = useMetaAction(workspace.id);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [statusRequest, setStatusRequest] = useState<StatusRequest | null>(null);
  const [budgetNode, setBudgetNode] = useState<TreeNode | null>(null);
  const [blocked, setBlocked] = useState<ControlBlock | null>(null);

  const block = useCallback(
    (accountId: string) =>
      controlBlock(
        accounts.data?.find((a) => a.id === accountId),
        connections.data ?? [],
        canManage,
      ),
    [accounts.data, connections.data, canManage],
  );

  const run = useCallback(
    (input: MetaAction, success: string, undo?: MetaAction) => {
      setPending((s) => new Set(s).add(input.id));
      setTouched((s) => (s.has(input.id) ? s : new Set(s).add(input.id)));
      // Promessa por chamada: os callbacks do mutate() só disparam para a última chamada.
      mutateAsync(input)
        .then(() =>
          toast.success(success, {
            action: undo
              ? { label: "Desfazer", onClick: () => run(undo, "Alteração desfeita.") }
              : undefined,
          }),
        )
        .catch((error: unknown) => toast.error(metaActionMessage(error)))
        .finally(() =>
          setPending((s) => {
            const next = new Set(s);
            next.delete(input.id);
            return next;
          }),
        );
    },
    [mutateAsync],
  );

  const guard = useCallback(
    (node: TreeNode) => {
      const reason = block(node.accountId);
      if (reason === "viewer") return false;
      if (reason) {
        setBlocked(reason);
        return false;
      }
      return true;
    },
    [block],
  );

  const value = useMemo<Ctx>(
    () => ({
      block,
      pending,
      currency,
      requestStatus: (node, ancestors) => {
        if (!canToggle(node) || !guard(node)) return;
        setStatusRequest({
          node,
          ancestors,
          next: node.configuredStatus === "ACTIVE" ? "PAUSED" : "ACTIVE",
        });
      },
      requestBudget: (node) => {
        if (node.budget && guard(node)) setBudgetNode(node);
      },
    }),
    [block, pending, currency, guard],
  );

  const confirmStatus = () => {
    if (!statusRequest) return;
    const { node, next } = statusRequest;
    const action = next === "PAUSED" ? "pause" : "activate";
    const undo = next === "PAUSED" ? "activate" : "pause";
    run(
      { level: node.level, id: node.id, action },
      `${NOUN[node.level].done(next === "PAUSED")}.`,
      { level: node.level, id: node.id, action: undo },
    );
    setStatusRequest(null);
  };

  return (
    <ControlsContext.Provider value={value}>
      <TouchedContext.Provider value={touched}>
        {children}
        <StatusDialog
          request={statusRequest}
          currency={currency}
          onCancel={() => setStatusRequest(null)}
          onConfirm={confirmStatus}
        />
        <BudgetDialog
          node={budgetNode}
          currency={currency}
          onClose={() => setBudgetNode(null)}
          onSave={(node, cents) => {
            const previous = node.budget!.cents;
            const level = node.level as "campaign" | "adset";
            run(
              { level, id: node.id, action: "set_budget", budgetCents: cents },
              `Orçamento de “${node.name}” agora é ${formatBudget({ ...node.budget!, cents }, currency)}.`,
              { level, id: node.id, action: "set_budget", budgetCents: previous },
            );
            setBudgetNode(null);
          }}
        />
        <BlockedDialog
          reason={blocked}
          workspaceId={workspace.id}
          onClose={() => setBlocked(null)}
        />
      </TouchedContext.Provider>
    </ControlsContext.Provider>
  );
}

function StatusDialog({
  request,
  currency,
  onCancel,
  onConfirm,
}: {
  request: StatusRequest | null;
  currency: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const node = request?.node;
  const pausing = request?.next === "PAUSED";
  const noun = node ? NOUN[node.level] : null;
  const pausedAbove = request?.ancestors.find((a) => a.configuredStatus === "PAUSED");
  // O orçamento que volta a gastar: o do próprio nível ou o da campanha (CBO).
  const budget = node?.budget ?? request?.ancestors.find((a) => a.budget)?.budget ?? null;
  return (
    <AlertDialog open={!!request} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        {node && noun && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pausing ? "Pausar" : "Ativar"} {noun.the}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                <span className="font-medium text-foreground">“{node.name}”</span>{" "}
                {pausing
                  ? node.level === "campaign"
                    ? "para de veicular agora, com todos os conjuntos e anúncios dela."
                    : node.level === "adset"
                      ? "para de veicular agora, com todos os anúncios dele."
                      : "para de veicular agora."
                  : `volta a veicular e a gastar${budget ? `, com orçamento de ${formatBudget(budget, currency)}` : ""}.`}{" "}
                A mudança vale na Meta na hora e você pode desfazer a qualquer momento.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {!pausing && pausedAbove && (
              <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-strong">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                {pausedAbove.level === "campaign" ? "A campanha" : "O conjunto"} “{pausedAbove.name}
                ” está pausado. {noun.the[0]!.toUpperCase() + noun.the.slice(1)} só entrega quando
                ele for ativado também.
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                onClick={onConfirm}
                className={cn(
                  pausing && "bg-destructive text-destructive-foreground hover:bg-danger-hover",
                )}
              >
                {pausing ? "Pausar" : "Ativar"} {noun.one}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

const STEPS = [-0.2, -0.1, 0.1, 0.2, 0.5];

function BudgetDialog({
  node,
  currency,
  onClose,
  onSave,
}: {
  node: TreeNode | null;
  currency: string;
  onClose: () => void;
  onSave: (node: TreeNode, cents: number) => void;
}) {
  return (
    <Dialog open={!!node} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {node?.budget && (
          // Remonta a cada objeto: o valor digitado começa do orçamento atual.
          <BudgetForm
            key={node.id}
            node={node}
            budget={node.budget}
            currency={currency}
            onClose={onClose}
            onSave={onSave}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BudgetForm({
  node,
  budget,
  currency,
  onClose,
  onSave,
}: {
  node: TreeNode;
  budget: Budget;
  currency: string;
  onClose: () => void;
  onSave: (node: TreeNode, cents: number) => void;
}) {
  const [reais, setReais] = useState(budget.cents / 100);
  const cents = Math.round(reais * 100);
  const delta = budgetChange(budget.cents, cents);
  const daily = budget.kind === "daily";
  const valid = cents >= 100 && cents !== budget.cents;
  const diff = cents - budget.cents;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{daily ? "Orçamento diário" : "Orçamento total"}</DialogTitle>
        <DialogDescription>
          {node.level === "campaign" ? "Campanha" : "Conjunto"}{" "}
          <span className="font-medium text-foreground">“{node.name}”</span>. Hoje:{" "}
          {formatBudget(budget, currency)}.
        </DialogDescription>
      </DialogHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave(node, cents);
        }}
      >
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="budget-value">
              {daily ? "Novo orçamento por dia" : "Novo orçamento total"}
            </Label>
            <MoneyInput
              id="budget-value"
              autoFocus
              currency={currency}
              value={reais}
              onChange={setReais}
            />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Atalhos">
            {STEPS.map((pct) => (
              <Button
                key={pct}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs tabular-nums"
                onClick={() => setReais(stepBudget(budget.cents, pct) / 100)}
              >
                {pct > 0 ? "+" : "−"}
                {Math.abs(pct * 100)}%
              </Button>
            ))}
          </div>
          {delta !== null && diff !== 0 && cents >= 100 && (
            <p className="text-sm tabular-nums text-muted-foreground">
              <span
                className={cn("font-medium", diff > 0 ? "text-foreground" : "text-success-strong")}
              >
                {diff > 0 ? "+" : "−"}
                {Math.abs(Math.round(delta * 100))}%
              </span>{" "}
              ({formatMoney(Math.abs(diff), currency)} {diff > 0 ? "a mais" : "a menos"}
              {daily ? " por dia" : ""})
            </p>
          )}
          {cents > 0 && cents < 100 && (
            <p className="text-xs text-danger-strong">
              O mínimo aqui é {formatMoney(100, currency)}.
            </p>
          )}
          {delta !== null && delta > 1 && (
            <p className="flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger-strong">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              Mais que o dobro do orçamento atual. Confira o valor antes de salvar.
            </p>
          )}
          {delta !== null && Math.abs(delta) > 0.2 && delta <= 1 && (
            <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-strong">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              Mudanças acima de 20% de uma vez podem fazer a Meta reiniciar a fase de aprendizado.
            </p>
          )}
          {!daily && (
            <p className="text-xs text-muted-foreground">
              É o valor para todo o período de veiculação, não por dia. A Meta não aceita menos do
              que já foi gasto.
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!valid}>
            Salvar orçamento
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function BlockedDialog({
  reason,
  workspaceId,
  onClose,
}: {
  reason: ControlBlock | null;
  workspaceId: string;
  onClose: () => void;
}) {
  return (
    <AlertDialog open={!!reason} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            {reason === "needs_scope" ? "Libere o controle dos anúncios" : "Reconecte a Meta Ads"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {reason === "needs_scope"
              ? "Para pausar, ativar e mudar orçamento por aqui, o Nishiads precisa da permissão de gerenciar anúncios. Reconecte a Meta em Integrações e aceite todas as permissões. Leva menos de um minuto."
              : "O acesso a esta conta de anúncio expirou. Reconecte em Integrações para voltar a controlar e sincronizar os anúncios."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Agora não</AlertDialogCancel>
          <AlertDialogAction asChild>
            <Link to={`/w/${workspaceId}/integracoes`}>Ir para Integrações</Link>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Chave de veiculação (como a do Gerenciador de Anúncios). Sem provider, não renderiza. */
export function DeliveryToggle({ node, ancestors }: { node: TreeNode; ancestors: TreeNode[] }) {
  const ctx = useMetaControls();
  if (!ctx) return null;
  const reason = ctx.block(node.accountId);
  const busy = ctx.pending.has(node.id);
  const on = node.configuredStatus === "ACTIVE";
  const title =
    reason === "viewer"
      ? "Só owners e admins podem pausar e ativar."
      : !canToggle(node)
        ? "Arquivado na Meta"
        : on
          ? `Pausar ${NOUN[node.level].one}`
          : `Ativar ${NOUN[node.level].one}`;
  return (
    <Switch
      checked={on}
      disabled={busy || reason === "viewer" || !canToggle(node)}
      onCheckedChange={() => ctx.requestStatus(node, ancestors)}
      onClick={(e) => e.stopPropagation()}
      aria-label={`${title}: ${node.name}`}
      title={title}
      className={cn("scale-90", busy && "animate-pulse")}
    />
  );
}

/** Orçamento da linha, com o lápis para editar (owner/admin). */
export function BudgetValue({ node, compact = false }: { node: TreeNode; compact?: boolean }) {
  const ctx = useMetaControls();
  if (node.level === "ad") return null;
  if (node.usesCampaignBudget) {
    return (
      <span className="text-xs text-muted-foreground" title="O orçamento fica na campanha (CBO).">
        {compact ? "na campanha" : "Na campanha"}
      </span>
    );
  }
  if (!node.budget) {
    // Campanha sem orçamento próprio (ABO): o orçamento está em cada conjunto.
    return node.level === "campaign" && node.children.some((c) => c.budget) ? (
      <span className="text-xs text-muted-foreground">Nos conjuntos</span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  }
  const editable = ctx && ctx.block(node.accountId) !== "viewer";
  const text = (
    <span className="tabular-nums">{formatBudget(node.budget, ctx?.currency ?? "BRL")}</span>
  );
  if (!editable) return text;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        ctx.requestBudget(node);
      }}
      disabled={ctx.pending.has(node.id)}
      className="group/budget -mx-1.5 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-foreground transition-colors hover:bg-surface-hover hover:text-primary disabled:opacity-60"
      aria-label={`Mudar orçamento de ${node.name}`}
    >
      {text}
      <Pencil
        className="h-3 w-3 text-muted-foreground group-hover/budget:text-primary"
        aria-hidden
      />
    </button>
  );
}

const ACTION_LABEL = { pause: "Pausou", activate: "Ativou" } as const;
const LEVEL_NAME: Record<Level, string> = {
  campaign: "a campanha",
  adset: "o conjunto",
  ad: "o anúncio",
};
const LEVEL_OF: Record<Level, string> = {
  campaign: "da campanha",
  adset: "do conjunto",
  ad: "do anúncio",
};

function budgetText(values: Record<string, unknown> | null, currency: string): string | null {
  if (!values) return null;
  const daily = values.daily_budget_cents;
  const lifetime = values.lifetime_budget_cents;
  if (typeof daily === "number") return `${formatMoney(daily, currency)}/dia`;
  if (typeof lifetime === "number") return `${formatMoney(lifetime, currency)} total`;
  return null;
}

export function describeAction(entry: ActionLogEntry, currency: string): string {
  const name = `“${entry.object_name ?? entry.object_id}”`;
  if (entry.action !== "set_budget") {
    return `${ACTION_LABEL[entry.action]} ${LEVEL_NAME[entry.level]} ${name}`;
  }
  const from = budgetText(entry.previous, currency);
  const to = budgetText(entry.requested, currency);
  return `Mudou o orçamento ${LEVEL_OF[entry.level]} ${name}${from ? ` de ${from}` : ""}${to ? ` para ${to}` : ""}`;
}

/** Histórico das alterações feitas pelo Nishiads na Meta (botões e regras). */
export function ActionHistoryButton({ currency }: { currency: string }) {
  const { workspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const log = useMetaActionLog(workspace.id, open);
  return (
    <>
      <Button variant="ghost" size="sm" className="h-8" onClick={() => setOpen(true)}>
        <History />
        <span className="hidden sm:inline">Histórico</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Histórico de alterações</DialogTitle>
            <DialogDescription>
              O que foi pausado, ativado ou mudou de orçamento pelo Nishiads. Mudanças feitas direto
              no Gerenciador de Anúncios não aparecem aqui.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="max-h-[60vh] overflow-y-auto p-0">
            {log.isError ? (
              <div className="p-4">
                <LoadError onRetry={() => log.refetch()} retrying={log.isFetching}>
                  Não foi possível carregar o histórico.
                </LoadError>
              </div>
            ) : log.isPending ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">Carregando…</p>
            ) : log.data.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  compact
                  icon={History}
                  title="Nenhuma alteração ainda"
                  description="Quando você pausar, ativar ou mudar um orçamento por aqui, fica registrado nesta lista."
                />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {log.data.map((e) => (
                  <li key={e.id} className="px-4 py-3 text-sm">
                    <p className="text-foreground">{describeAction(e, currency)}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {e.source === "rule"
                        ? "Regra automática"
                        : (e.actor?.full_name ?? e.actor?.email ?? "Alguém")}
                      {" · "}
                      {formatDateTime(e.created_at, workspace.timezone)}
                    </p>
                    {!e.ok && (
                      <p className="mt-1 flex items-start gap-1.5 text-xs text-danger-strong">
                        <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                        Não aplicada: {e.error ?? "a Meta recusou."}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
