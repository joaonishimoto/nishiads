import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/app/form-field";
import { LoadError } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { useAdAccounts } from "@/features/meta/api";
import { useCampaignOptions, usePreviewRule, useSaveRule, type PreviewMatch } from "@/features/alerts/api";
import {
  ACTION_LABEL,
  CONDITION_LABEL,
  describeRule,
  LEVEL_LABEL,
  validateRule,
  WINDOW_OPTION,
  type RuleDraft,
  type RuleErrors,
} from "@/features/alerts/rules";
import type { AlertAction, AlertCondition, AlertLevel, AlertWindow } from "@/types/database";
import { friendlyError } from "@/lib/errors";
import { formatMoney, plural } from "@/lib/format";

const ALL = "all";

const ACTION_HINT: Record<AlertAction, string> = {
  notify: "Manda o push e registra o alerta. Nada muda na Meta.",
  approve_pause: "Manda o push com o botão Pausar. Você decide com um toque.",
  auto_pause: "Pausa na hora e avisa. Passou do limite do dia, volta a pedir aprovação.",
};

export function RuleFormDialog({
  open,
  onOpenChange,
  ruleId,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ruleId: string | null;
  initial: RuleDraft;
}) {
  const { workspace } = useWorkspace();
  const save = useSaveRule(workspace.id);
  const preview = usePreviewRule(workspace.id);
  const accounts = useAdAccounts(workspace.id);
  const campaigns = useCampaignOptions(workspace.id, open);
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [errors, setErrors] = useState<RuleErrors>({});
  const { reset: resetPreview } = preview;

  useEffect(() => {
    if (open) {
      setDraft(initial);
      setErrors({});
      resetPreview();
    }
  }, [open, initial, resetPreview]);

  const set = (patch: Partial<RuleDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    resetPreview();
  };

  const tracked = (accounts.data ?? []).filter((a) => a.is_tracked);
  const campaignChoices = useMemo(
    () => (campaigns.data ?? []).filter((c) => !draft.ad_account_id || c.ad_account_id === draft.ad_account_id),
    [campaigns.data, draft.ad_account_id],
  );

  const checked = validateRule(draft);
  const summary = checked.values ? describeRule(checked.values, workspace.currency) : null;

  function submit() {
    const result = validateRule(draft);
    setErrors(result.errors);
    if (!result.values) return;
    save.mutate(
      { id: ruleId, values: result.values },
      {
        onSuccess: () => {
          toast.success(ruleId ? "Regra salva." : "Regra criada. Ela roda a cada sincronização da Meta.");
          onOpenChange(false);
        },
        onError: (error) => toast.error(friendlyError(error)),
      },
    );
  }

  function runPreview() {
    const result = validateRule(draft);
    setErrors(result.errors);
    if (result.values) preview.mutate(result.values);
  }

  const moneyField = draft.condition !== "roas_below";
  const needsMinSpend = draft.condition !== "spend_without_sale";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{ruleId ? "Editar regra" : "Nova regra"}</DialogTitle>
          <DialogDescription>
            Confere os números de cada campanha, conjunto ou anúncio ativo depois de cada sincronização da Meta
            (a cada 15 minutos). Dispara no máximo uma vez por dia para cada item.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <FormField label="Nome" error={errors.name}>
            <Input
              value={draft.name}
              maxLength={80}
              placeholder="Ex.: Anúncio sem venda"
              onChange={(e) => set({ name: e.target.value })}
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Quando">
              <Select
                value={draft.condition}
                onValueChange={(v) => {
                  const condition = v as AlertCondition;
                  set({
                    condition,
                    min_roas: condition === "roas_below" && !draft.min_roas ? "1,5" : draft.min_roas,
                    threshold: condition === "roas_below" ? draft.threshold : draft.threshold || 100,
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(CONDITION_LABEL) as AlertCondition[]).map((c) => (
                    <SelectItem key={c} value={c}>
                      {CONDITION_LABEL[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Nível">
              <Select value={draft.level} onValueChange={(v) => set({ level: v as AlertLevel })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(LEVEL_LABEL) as AlertLevel[]).map((l) => (
                    <SelectItem key={l} value={l}>
                      {LEVEL_LABEL[l]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Período">
              <Select value={draft.time_window} onValueChange={(v) => set({ time_window: v as AlertWindow })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(WINDOW_OPTION) as AlertWindow[]).map((w) => (
                    <SelectItem key={w} value={w}>
                      {WINDOW_OPTION[w]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {moneyField ? (
              <FormField
                label={draft.condition === "cpa_above" ? "CPA máximo" : "Gasto sem venda"}
                error={errors.threshold}
                hint={
                  draft.condition === "cpa_above"
                    ? "Sem nenhuma venda, conta o gasto inteiro."
                    : "Dispara quando gastar isso sem nenhuma venda."
                }
              >
                <MoneyInput currency={workspace.currency} value={draft.threshold} onChange={(v) => set({ threshold: v })} />
              </FormField>
            ) : (
              <FormField label="ROAS mínimo" error={errors.min_roas} hint="Faturamento ÷ gasto. Ex.: 1,5">
                <Input
                  inputMode="decimal"
                  placeholder="1,5"
                  value={draft.min_roas}
                  onChange={(e) => set({ min_roas: e.target.value.replace(/[^\d,.]/g, "").slice(0, 6) })}
                />
              </FormField>
            )}
            {needsMinSpend && (
              <FormField
                label="Só depois de gastar"
                error={errors.min_spend}
                hint="Evita alerta com pouco dado no começo do dia."
              >
                <MoneyInput currency={workspace.currency} value={draft.min_spend} onChange={(v) => set({ min_spend: v })} />
              </FormField>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Conta de anúncio">
              <Select
                value={draft.ad_account_id ?? ALL}
                onValueChange={(v) => set({ ad_account_id: v === ALL ? null : v, campaign_id: null })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todas as contas</SelectItem>
                  {tracked.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Campanha">
              <Select
                value={draft.campaign_id ?? ALL}
                onValueChange={(v) => set({ campaign_id: v === ALL ? null : v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todas as campanhas</SelectItem>
                  {campaignChoices.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.effective_status !== "ACTIVE" ? " (pausada)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-sm font-medium text-foreground">O que fazer</legend>
            <RadioGroup value={draft.action} onValueChange={(v) => set({ action: v as AlertAction })}>
              {(Object.keys(ACTION_LABEL) as AlertAction[]).map((a) => (
                <label
                  key={a}
                  className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 has-[[data-state=checked]]:border-primary"
                >
                  <RadioGroupItem value={a} className="mt-0.5" aria-label={ACTION_LABEL[a]} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{ACTION_LABEL[a]}</span>
                    <span className="block text-xs text-muted-foreground">{ACTION_HINT[a]}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            {draft.action === "auto_pause" && (
              <div className="grid grid-cols-[8rem_1fr] items-center gap-3 pt-1">
                <Label htmlFor="max-auto">Até quantas pausas por dia</Label>
                <Input
                  id="max-auto"
                  inputMode="numeric"
                  className="w-24"
                  value={String(draft.max_auto_pauses_per_day || "")}
                  aria-invalid={errors.max_auto_pauses_per_day ? true : undefined}
                  onChange={(e) => set({ max_auto_pauses_per_day: Number(e.target.value.replace(/\D/g, "").slice(0, 2)) })}
                />
                {errors.max_auto_pauses_per_day && (
                  <p className="col-span-2 text-xs text-danger-strong">{errors.max_auto_pauses_per_day}</p>
                )}
              </div>
            )}
            {draft.action !== "notify" && (
              <p className="text-xs text-muted-foreground">
                Para pausar, a conexão com a Meta precisa da permissão de gerenciar anúncios. Se faltar, o alerta avisa e
                você reconecta em Integrações.
              </p>
            )}
          </fieldset>

          <div className="rounded-md border border-border bg-surface-muted/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 text-sm text-foreground">{summary ?? "Preencha os campos para ver a regra."}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={preview.isPending}
                loadingText="Conferindo…"
                onClick={runPreview}
              >
                <Eye className="h-4 w-4" />
                Ver o que dispararia agora
              </Button>
            </div>
            {preview.isError && (
              <div className="mt-3">
                <LoadError>{friendlyError(preview.error)}</LoadError>
              </div>
            )}
            {preview.data && <PreviewList matches={preview.data} currency={workspace.currency} />}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={save.isPending} loadingText="Salvando…">
            {ruleId ? "Salvar" : "Criar regra"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewList({ matches, currency }: { matches: PreviewMatch[]; currency: string }) {
  if (!matches.length) {
    return <p className="mt-2 text-xs text-muted-foreground">Agora, nada dispararia com estes valores.</p>;
  }
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-foreground">
        Dispararia agora para {plural(matches.length, "item", "itens")}
        {matches.length === 50 ? " (mostrando os 50 de maior gasto)" : ""}:
      </p>
      <ul className="mt-1.5 max-h-40 divide-y divide-border overflow-y-auto text-xs">
        {matches.map((m) => (
          <li key={m.object_id} className="flex items-center justify-between gap-3 py-1.5">
            <span className="min-w-0 truncate text-foreground">{m.object_name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatMoney(m.spend_cents, currency)} · {plural(m.sales, "venda", "vendas")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
