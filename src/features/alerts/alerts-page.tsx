import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  BellRing,
  CirclePause,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  TrendingDown,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { EmptyState, LoadError, PageHeader, PageSkeleton, Panel, Status, type Tone } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import {
  useAlertRules,
  useAlerts,
  useApproveAlert,
  useDeleteRule,
  useDismissAlert,
  useEvaluateNow,
  useToggleRule,
} from "@/features/alerts/api";
import { RuleFormDialog } from "@/features/alerts/rule-form";
import {
  ACTION_LABEL,
  alertHeadline,
  alertWindowText,
  canPause,
  describeRule,
  EMPTY_DRAFT,
  LEVEL_LABEL,
  RULE_PRESETS,
  ruleToDraft,
  STATUS_LABEL,
  type Alert,
  type AlertRule,
  type RuleDraft,
} from "@/features/alerts/rules";
import type { AlertCondition, AlertStatus } from "@/types/database";
import { friendlyError } from "@/lib/errors";
import { formatDateTime, formatMoney, plural } from "@/lib/format";
import { ymdInZone } from "@/lib/period";
import { cn } from "@/lib/utils";

const CONDITION_ICON: Record<AlertCondition, LucideIcon> = {
  spend_without_sale: Wallet,
  roas_below: TrendingDown,
  cpa_above: ShieldAlert,
};

const STATUS_TONE: Record<AlertStatus, Tone> = {
  notified: "info",
  pending: "warning",
  pausing: "info",
  paused: "success",
  dismissed: "neutral",
  expired: "neutral",
};

export function AlertsPage() {
  const { workspace, canManage } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const tab = params.get("aba") === "regras" ? "regras" : "alertas";
  const rules = useAlertRules(workspace.id);
  const evaluate = useEvaluateNow(workspace.id);
  const [form, setForm] = useState<{ id: string | null; draft: RuleDraft } | null>(null);

  const setTab = (value: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (value === "regras") next.set("aba", "regras");
        else next.delete("aba");
        return next;
      },
      { replace: true },
    );

  const openNew = (draft: RuleDraft = EMPTY_DRAFT) => setForm({ id: null, draft });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alertas"
        subtitle="Regras que vigiam gasto, ROAS e CPA a cada sincronização da Meta e avisam no seu celular."
        actions={
          canManage && (
            <>
              <Button
                variant="outline"
                loading={evaluate.isPending}
                loadingText="Conferindo…"
                disabled={!rules.data?.some((r) => r.enabled)}
                onClick={() =>
                  evaluate.mutate(undefined, {
                    onSuccess: ({ created }) =>
                      toast.success(
                        created ? `${plural(created, "alerta novo", "alertas novos")}.` : "Nenhum alerta novo agora.",
                      ),
                    onError: (error) => toast.error(friendlyError(error)),
                  })
                }
              >
                <RefreshCw className="h-4 w-4" />
                Conferir agora
              </Button>
              <Button onClick={() => openNew()}>
                <Plus className="h-4 w-4" />
                Nova regra
              </Button>
            </>
          )
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="alertas">Alertas</TabsTrigger>
          <TabsTrigger value="regras">
            Regras
            {rules.data && rules.data.length > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">{rules.data.length}</span>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="alertas" className="mt-5">
          <AlertsTab
            hasRules={!!rules.data?.length}
            onCreateRule={() => {
              setTab("regras");
              if (canManage) openNew();
            }}
          />
        </TabsContent>
        <TabsContent value="regras" className="mt-5">
          <RulesTab
            rules={rules}
            onNew={openNew}
            onEdit={(rule) => setForm({ id: rule.id, draft: ruleToDraft(rule) })}
          />
        </TabsContent>
      </Tabs>

      <RuleFormDialog
        open={form !== null}
        onOpenChange={(open) => !open && setForm(null)}
        ruleId={form?.id ?? null}
        initial={form?.draft ?? EMPTY_DRAFT}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alertas
// ---------------------------------------------------------------------------

function AlertsTab({ hasRules, onCreateRule }: { hasRules: boolean; onCreateRule: () => void }) {
  const { workspace, canManage } = useWorkspace();
  const alerts = useAlerts(workspace.id);
  const approve = useApproveAlert(workspace.id);
  const [params, setParams] = useSearchParams();
  const focusId = params.get("alerta");
  const [confirm, setConfirm] = useState<Alert | null>(null);

  // Tocou em "Pausar" no push: abre a confirmação (um toque) em vez de pausar sozinho pelo link.
  useEffect(() => {
    if (params.get("acao") !== "pausar" || !alerts.data) return;
    const target = alerts.data.find((a) => a.id === focusId);
    if (target && canPause(target) && canManage) setConfirm(target);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("acao");
        return next;
      },
      { replace: true },
    );
  }, [alerts.data, focusId, params, setParams, canManage]);

  if (alerts.isPending) return <PageSkeleton variant="table" />;
  if (alerts.isError) {
    return (
      <LoadError onRetry={() => alerts.refetch()} retrying={alerts.isFetching}>
        Não foi possível carregar os alertas.
      </LoadError>
    );
  }

  const pending = alerts.data.filter((a) => a.status === "pending" || a.status === "pausing");
  const history = alerts.data.filter((a) => !pending.includes(a));

  if (!alerts.data.length) {
    return (
      <EmptyState
        icon={BellRing}
        title={hasRules ? "Nenhum alerta ainda" : "Crie sua primeira regra"}
        description={
          hasRules
            ? "Quando uma regra disparar, o alerta aparece aqui e no seu celular."
            : "Ex.: avisar quando um anúncio gastar R$ 100 sem venda e pausar com um toque."
        }
        action={
          !hasRules && canManage ? (
            <Button onClick={onCreateRule}>
              <Plus className="h-4 w-4" />
              Nova regra
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      {pending.length > 0 && (
        <Panel
          title="Esperando você"
          description={
            canManage
              ? "Pause com um toque ou ignore. Sem resposta, o pedido expira em 24 horas."
              : "Só owners e admins podem pausar ou ignorar."
          }
        >
          <ul className="divide-y divide-border">
            {pending.map((a) => (
              <AlertItem
                key={a.id}
                alert={a}
                focused={a.id === focusId}
                pausing={approve.isPending && approve.variables === a.id}
                onPause={() => approveNow(a)}
              />
            ))}
          </ul>
        </Panel>
      )}
      {history.length > 0 && (
        <Panel title="Histórico" description="Últimos 200 alertas deste workspace.">
          <ul className="divide-y divide-border">
            {history.map((a) => (
              <AlertItem
                key={a.id}
                alert={a}
                focused={a.id === focusId}
                pausing={approve.isPending && approve.variables === a.id}
                onPause={() => approveNow(a)}
              />
            ))}
          </ul>
        </Panel>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Pausar {confirm ? LEVEL_LABEL[confirm.level].toLowerCase() : ""} “{confirm?.object_name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm ? `${alertHeadline(confirm)} ${alertWindowText(confirm, ymdInZone(new Date(), workspace.timezone))}. ` : ""}
              Ele para de gastar na hora. Dá para reativar depois na tela de Campanhas ou no Gerenciador da Meta.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Agora não</AlertDialogCancel>
            <AlertDialogAction
              loading={approve.isPending}
              loadingText="Pausando…"
              onClick={(event) => {
                event.preventDefault();
                if (confirm) approveNow(confirm, () => setConfirm(null));
              }}
            >
              <CirclePause className="h-4 w-4" />
              Pausar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  function approveNow(alert: Alert, done?: () => void) {
    approve.mutate(alert.id, {
      onSuccess: () => {
        toast.success(`${LEVEL_LABEL[alert.level]} “${alert.object_name}” pausado.`);
        done?.();
      },
      onError: (error) => {
        toast.error(friendlyError(error));
        done?.();
      },
    });
  }
}

function AlertItem({
  alert,
  focused,
  pausing,
  onPause,
}: {
  alert: Alert;
  focused: boolean;
  pausing: boolean;
  onPause: () => void;
}) {
  const { workspace, canManage } = useWorkspace();
  const dismiss = useDismissAlert(workspace.id);
  const ref = useRef<HTMLLIElement>(null);
  const Icon = CONDITION_ICON[alert.condition];
  const money = (c: number) => formatMoney(c, alert.currency);

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focused]);

  const metric =
    alert.condition === "roas_below"
      ? `ROAS ${Number(alert.roas ?? 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}`
      : alert.cpa_cents !== null
        ? `CPA ${money(alert.cpa_cents)}`
        : null;
  const actionable = canManage && canPause(alert);

  return (
    <li
      ref={ref}
      className={cn("flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center", focused && "bg-accent/40")}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
            alert.status === "pending" ? "bg-warning/12 text-warning-strong" : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
            {alertHeadline(alert)}
            <Status tone={STATUS_TONE[alert.status]}>
              {alert.status === "paused" && alert.auto_action && !alert.resolved_by ? "Pausado sozinho" : STATUS_LABEL[alert.status]}
            </Status>
          </p>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {LEVEL_LABEL[alert.level]} “{alert.object_name}” · {alertWindowText(alert, ymdInZone(new Date(), workspace.timezone))}
          </p>
          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
            Gasto {money(alert.spend_cents)} · {plural(alert.sales, "venda", "vendas")}
            {metric ? ` · ${metric}` : ""} · regra “{alert.rule_name}” · {formatDateTime(alert.created_at, workspace.timezone)}
          </p>
          {alert.error && canPause(alert) && <p className="mt-1 text-xs text-danger-strong">{alert.error}</p>}
        </div>
      </div>
      {actionable && (
        <div className="flex shrink-0 gap-2 sm:justify-end">
          {(alert.status === "pending" || alert.status === "notified") && (
            <Button
              variant="ghost"
              size="sm"
              loading={dismiss.isPending}
              loadingText="Ignorando…"
              onClick={() => dismiss.mutate(alert.id, { onError: (error) => toast.error(friendlyError(error)) })}
            >
              Ignorar
            </Button>
          )}
          <Button
            size="sm"
            variant={alert.status === "pending" ? "default" : "outline"}
            loading={pausing || alert.status === "pausing"}
            loadingText="Pausando…"
            onClick={onPause}
          >
            <CirclePause className="h-4 w-4" />
            Pausar
          </Button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------

function RulesTab({
  rules,
  onNew,
  onEdit,
}: {
  rules: ReturnType<typeof useAlertRules>;
  onNew: (draft?: RuleDraft) => void;
  onEdit: (rule: AlertRule) => void;
}) {
  const { workspace, canManage } = useWorkspace();
  const toggle = useToggleRule(workspace.id);
  const remove = useDeleteRule(workspace.id);
  const [deleting, setDeleting] = useState<AlertRule | null>(null);

  if (rules.isPending) return <PageSkeleton variant="table" />;
  if (rules.isError) {
    return (
      <LoadError onRetry={() => rules.refetch()} retrying={rules.isFetching}>
        Não foi possível carregar as regras.
      </LoadError>
    );
  }

  return (
    <div className="space-y-6">
      {rules.data.length > 0 ? (
        <Panel title="Suas regras" description="Rodam a cada sincronização da Meta, só nos itens ativos.">
          <ul className="divide-y divide-border">
            {rules.data.map((rule) => (
              <li key={rule.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                    {rule.name}
                    <Status tone={rule.action === "auto_pause" ? "warning" : rule.action === "approve_pause" ? "info" : "neutral"}>
                      {ACTION_LABEL[rule.action]}
                      {rule.action === "auto_pause" ? ` (até ${rule.max_auto_pauses_per_day}/dia)` : ""}
                    </Status>
                  </p>
                  <p className="text-sm text-muted-foreground">{describeRule(rule, workspace.currency)}</p>
                  {rule.last_evaluated_at && (
                    <p className="text-xs text-muted-foreground">
                      Conferida em {formatDateTime(rule.last_evaluated_at, workspace.timezone)}
                    </p>
                  )}
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={rule.enabled}
                      aria-label={rule.enabled ? "Desligar regra" : "Ligar regra"}
                      onCheckedChange={(enabled) =>
                        toggle.mutate({ id: rule.id, enabled }, { onError: (error) => toast.error(friendlyError(error)) })
                      }
                    />
                    <Button variant="ghost" size="icon" aria-label="Editar regra" onClick={() => onEdit(rule)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label="Apagar regra" onClick={() => setDeleting(rule)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
                {!canManage && <Status tone={rule.enabled ? "success" : "neutral"}>{rule.enabled ? "Ligada" : "Desligada"}</Status>}
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        !canManage && (
          <EmptyState
            icon={BellRing}
            title="Nenhuma regra ainda"
            description="Owners e admins criam as regras do workspace."
          />
        )
      )}

      {canManage && (
        <Panel
          title={rules.data.length ? "Modelos" : "Comece por um modelo"}
          description="Abre o formulário preenchido; ajuste os valores ao seu produto."
        >
          <ul className="grid gap-3 p-4 sm:grid-cols-3">
            {RULE_PRESETS.map((preset) => (
              <li key={preset.key}>
                <button
                  type="button"
                  onClick={() => onNew(preset.draft)}
                  className="h-full w-full rounded-md border border-border p-3 text-left transition-colors hover:border-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="block text-sm font-medium text-foreground">{preset.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{preset.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar a regra “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Ela para de conferir os anúncios. Os alertas que ela já disparou continuam no histórico. Para só pausar a
              regra, use a chave ao lado.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-danger-hover"
              loading={remove.isPending}
              loadingText="Apagando…"
              onClick={(event) => {
                event.preventDefault();
                if (!deleting) return;
                remove.mutate(deleting.id, {
                  onSuccess: () => {
                    toast.success("Regra apagada.");
                    setDeleting(null);
                  },
                  onError: (error) => toast.error(friendlyError(error)),
                });
              }}
            >
              Apagar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
