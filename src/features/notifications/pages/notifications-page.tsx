import { useState, type FormEvent, type ReactNode } from "react";
import { BellOff, BellRing, Send, Smartphone, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FormField } from "@/components/app/form-field";
import { LoadError, PageHeader, Panel, Status } from "@/components/app/ui";
import { useUser } from "@/features/auth/auth-provider";
import { SettingsNav } from "@/features/workspaces/pages/settings-nav";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import {
  useEnablePush,
  useNotificationPreferences,
  usePushConfig,
  usePushDevices,
  useRemoveDevice,
  useSendTestPush,
  useThisDeviceEndpoint,
  useUpdatePreferences,
  type NotificationPreferences,
  type PreferencesPatch,
} from "@/features/notifications/api";
import { describeUserAgent, pushSupport, PushPermissionDenied } from "@/features/notifications/push";
import { friendlyError } from "@/lib/errors";
import { formatDateTime, parseReais } from "@/lib/format";

export function NotificationsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Ajustes" subtitle="Dados do workspace, equipe e sua conta." />
      <SettingsNav />
      <ThisDevicePanel />
      <DevicesPanel />
      <PreferencesPanel />
    </div>
  );
}

function pushErrorMessage(error: unknown): string {
  if (error instanceof PushPermissionDenied) {
    return "Você bloqueou as notificações. Libere nas configurações do navegador (ícone de cadeado ao lado do endereço) e tente de novo.";
  }
  if (error instanceof Error && error.message === "push_not_configured") {
    return "O envio de push ainda não foi configurado no servidor.";
  }
  return friendlyError(error);
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="p-4 text-sm leading-5 text-muted-foreground">{children}</p>;
}

function ThisDevicePanel() {
  const { workspace } = useWorkspace();
  const user = useUser();
  const support = pushSupport();
  const config = usePushConfig();
  const thisDevice = useThisDeviceEndpoint();
  const devices = usePushDevices(workspace.id, user.id);
  const enable = useEnablePush(workspace.id, user.id);
  const remove = useRemoveDevice(workspace.id, user.id);
  const test = useSendTestPush(workspace.id);

  const title = "Este dispositivo";
  const description = "Receba um aviso no celular ou no computador a cada venda.";

  if (support.kind === "needs-install") {
    return (
      <Panel title={title} description={description}>
        <Notice>
          No iPhone e no iPad, as notificações só funcionam com o Nishiads instalado. Toque em Compartilhar ›
          “Adicionar à Tela de Início”, abra o app por lá e volte a esta tela.
        </Notice>
      </Panel>
    );
  }
  if (support.kind === "unsupported") {
    return (
      <Panel title={title} description={description}>
        <Notice>Este navegador não suporta notificações push. Use Chrome, Edge, Firefox ou Safari atualizados.</Notice>
      </Panel>
    );
  }

  const current = devices.data?.find((d) => d.endpoint === thisDevice.data && d.active);
  const denied = typeof Notification !== "undefined" && Notification.permission === "denied";
  const configError = config.isError ? pushErrorMessage(config.error) : null;

  return (
    <Panel
      title={title}
      description={description}
      action={current ? <Status tone="success">Ativo</Status> : <Status>Desativado</Status>}
    >
      <div className="grid gap-4 p-4">
        {configError && <LoadError>{configError}</LoadError>}
        {enable.isError && <LoadError>{pushErrorMessage(enable.error)}</LoadError>}
        {test.isError && <LoadError>{pushErrorMessage(test.error)}</LoadError>}
        {denied && !current && (
          <LoadError>
            As notificações estão bloqueadas neste navegador. Libere nas configurações do site e recarregue a página.
          </LoadError>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {current
              ? `Você recebe as vendas de “${workspace.name}” aqui.`
              : `Ative para receber as vendas de “${workspace.name}” neste navegador.`}
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            {current ? (
              <>
                <Button
                  variant="outline"
                  loading={test.isPending}
                  loadingText="Enviando…"
                  onClick={() =>
                    test.mutate(undefined, {
                      onSuccess: ({ delivered }) =>
                        delivered > 0
                          ? toast.success("Notificação de teste enviada.")
                          : toast.error("Nenhum dispositivo recebeu. Tente desativar e ativar de novo."),
                    })
                  }
                >
                  <Send className="h-4 w-4" />
                  Enviar teste
                </Button>
                <Button
                  variant="outline"
                  loading={remove.isPending}
                  loadingText="Desativando…"
                  onClick={() =>
                    remove.mutate(current, { onSuccess: () => toast.success("Notificações desativadas aqui.") })
                  }
                >
                  <BellOff className="h-4 w-4" />
                  Desativar
                </Button>
              </>
            ) : (
              <Button
                disabled={!config.data || denied}
                loading={enable.isPending || config.isPending}
                loadingText={config.isPending ? "Carregando…" : "Ativando…"}
                onClick={() =>
                  config.data &&
                  enable.mutate(config.data, { onSuccess: () => toast.success("Notificações ativadas.") })
                }
              >
                <BellRing className="h-4 w-4" />
                Ativar notificações
              </Button>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function DevicesPanel() {
  const { workspace } = useWorkspace();
  const user = useUser();
  const devices = usePushDevices(workspace.id, user.id);
  const thisDevice = useThisDeviceEndpoint();
  const remove = useRemoveDevice(workspace.id, user.id);

  if (devices.isError) {
    return (
      <LoadError onRetry={() => devices.refetch()} retrying={devices.isFetching}>
        Não foi possível carregar seus dispositivos.
      </LoadError>
    );
  }
  if (!devices.data?.length) return null;

  return (
    <Panel title="Seus dispositivos" description="Onde você recebe as notificações deste workspace.">
      <ul className="divide-y divide-border">
        {devices.data.map((device) => (
          <li key={device.id} className="flex items-center gap-3 px-4 py-3">
            <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                {describeUserAgent(device.user_agent)}
                {device.endpoint === thisDevice.data && <Status tone="info">Este dispositivo</Status>}
                {!device.active && <Status tone="warning">Expirado</Status>}
              </p>
              <p className="text-xs text-muted-foreground">
                {device.last_used_at
                  ? `Última notificação em ${formatDateTime(device.last_used_at, workspace.timezone)}`
                  : `Ativado em ${formatDateTime(device.created_at, workspace.timezone)}`}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remover dispositivo"
              disabled={remove.isPending}
              onClick={() => remove.mutate(device, { onSuccess: () => toast.success("Dispositivo removido.") })}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function PreferencesPanel() {
  const { workspace } = useWorkspace();
  const user = useUser();
  const prefs = useNotificationPreferences(workspace.id, user.id);
  const update = useUpdatePreferences(workspace.id, user.id);

  if (prefs.isError) {
    return (
      <LoadError onRetry={() => prefs.refetch()} retrying={prefs.isFetching}>
        Não foi possível carregar suas preferências.
      </LoadError>
    );
  }
  if (!prefs.data) return null;
  const p = prefs.data;

  const save = (patch: PreferencesPatch) =>
    update.mutate(patch, { onError: (error) => toast.error(friendlyError(error)) });

  return (
    <Panel title="O que notificar" description="Valem para todos os seus dispositivos neste workspace.">
      <div className="divide-y divide-border">
        <ToggleRow
          label="Venda aprovada"
          checked={p.notify_approved}
          onChange={(v) => save({ notify_approved: v })}
        />
        <ToggleRow
          label="Reembolso"
          checked={p.notify_refunded}
          onChange={(v) => save({ notify_refunded: v })}
        />
        <ToggleRow
          label="Chargeback"
          checked={p.notify_chargeback}
          onChange={(v) => save({ notify_chargeback: v })}
        />
        <ToggleRow
          label="Som"
          hint="Desligado, a notificação chega em silêncio."
          checked={p.sound_enabled}
          onChange={(v) => save({ sound_enabled: v })}
        />
        <LimitsForm key={p.updated_at} prefs={p} timezone={workspace.timezone} />
      </div>
    </Panel>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function centsToInput(cents: number): string {
  return cents ? (cents / 100).toFixed(2).replace(".", ",") : "";
}

function LimitsForm({ prefs, timezone }: { prefs: NotificationPreferences; timezone: string }) {
  const user = useUser();
  const update = useUpdatePreferences(prefs.workspace_id, user.id);
  const [minAmount, setMinAmount] = useState(centsToInput(prefs.min_amount_cents));
  const [quiet, setQuiet] = useState(prefs.quiet_hours_start !== null);
  const [start, setStart] = useState(prefs.quiet_hours_start?.slice(0, 5) ?? "22:00");
  const [end, setEnd] = useState(prefs.quiet_hours_end?.slice(0, 5) ?? "07:00");
  const [error, setError] = useState<string | undefined>();

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const cents = parseReais(minAmount);
    if (cents === null) {
      setError("Informe um valor em reais, como 97,00.");
      return;
    }
    setError(undefined);
    update.mutate(
      {
        min_amount_cents: cents,
        quiet_hours_start: quiet ? start : null,
        quiet_hours_end: quiet ? end : null,
      },
      {
        onSuccess: () => toast.success("Preferências salvas."),
        onError: (e) => toast.error(friendlyError(e)),
      },
    );
  }

  return (
    <form className="grid gap-4 p-4" onSubmit={onSubmit} noValidate>
      <FormField label="Valor mínimo da venda" error={error} hint="Vendas abaixo deste valor não notificam. Vazio: todas.">
        <Input inputMode="decimal" placeholder="0,00" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} />
      </FormField>
      <label className="flex cursor-pointer items-center justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">Horário de silêncio</span>
          <span className="block text-xs text-muted-foreground">Sem push neste intervalo (fuso {timezone}).</span>
        </span>
        <Switch checked={quiet} onCheckedChange={setQuiet} />
      </label>
      {quiet && (
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Das">
            <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </FormField>
          <FormField label="Até">
            <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </FormField>
        </div>
      )}
      <div className="flex justify-end">
        <Button type="submit" loading={update.isPending} loadingText="Salvando…">
          Salvar
        </Button>
      </div>
    </form>
  );
}
