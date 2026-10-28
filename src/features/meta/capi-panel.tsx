import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import {
  AlertTriangle,
  ChevronDown,
  FlaskConical,
  ListChecks,
  Pencil,
  Send,
  Unplug,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { FormField } from "@/components/app/form-field";
import { LoadError, Status, type Tone } from "@/components/app/ui";
import { ProviderMark } from "@/features/integrations/provider-mark";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import {
  capiErrorMessage,
  useCapiBackfill,
  useCapiConfig,
  useCapiStats,
  useCapiTest,
  useDeleteCapiConfig,
  useSaveCapiConfig,
  type CapiConfig,
} from "@/features/meta/capi-api";
import { friendlyError } from "@/lib/errors";
import { formatDateTime, plural } from "@/lib/format";
import { validate, type FieldErrors } from "@/lib/form";

/** Passo a passo do Gerenciador de Eventos (exportado para a Documentação). */
export const CAPI_GUIDE_STEPS = [
  "Abra o Gerenciador de Eventos da Meta (business.facebook.com/events_manager) e escolha, em Fontes de dados, o pixel (conjunto de dados) do seu site.",
  "Copie o ID do pixel, o número que aparece abaixo do nome dele (também em Configurações › ID do conjunto de dados).",
  "Ainda em Configurações, desça até API de Conversões e clique em Gerar token de acesso (fica em Configurar integração direta). Copie o token, que começa com EAA. A Meta mostra o token uma vez só.",
  "Aqui no Nishistack - ADS, clique em Configurar e cole o ID do pixel, o token e a URL do seu site.",
  "Para conferir: no Gerenciador de Eventos, abra a aba Testar eventos e copie o código de teste (ex.: TEST12345). Cole no campo Código de teste, salve e clique em Enviar evento de teste. Em alguns segundos o evento aparece lá.",
  "Depois de conferir, apague o código de teste e salve de novo. Com o código, as vendas vão para a tela de testes.",
];

export const CAPI_CLICK_NOTE =
  "Para a Meta ligar cada venda ao clique no anúncio, o checkout pode mandar os cookies _fbc e _fbp do navegador (ou o fbclid da URL) e o user agent. Na Stripe, coloque fbc, fbp e client_user_agent no metadata da Checkout Session e em subscription_data.metadata; na Kiwify, o fbclid é usado quando vem nos parâmetros de rastreamento. Sem eles, a venda vai só com o e-mail (com hash), o que já funciona, mas casa menos.";

const formSchema = z.object({
  pixelId: z
    .string()
    .trim()
    .regex(/^[0-9]{5,25}$/, "O ID do pixel tem só números (ex.: 1234567890123456)."),
  eventSourceUrl: z
    .string()
    .trim()
    .regex(/^https?:\/\/\S+$/, "Informe a URL do site, começando com https://.")
    .max(500, "Use no máximo 500 caracteres."),
  accessToken: z
    .string()
    .trim()
    .refine((v) => v === "" || (v.length >= 50 && v.length <= 1000 && !/\s/.test(v)), {
      message: "O token parece incompleto. Copie de novo do Gerenciador de Eventos.",
    }),
  testEventCode: z
    .string()
    .trim()
    .refine((v) => v === "" || /^[A-Za-z0-9]{4,40}$/.test(v), {
      message: "O código de teste tem só letras e números (ex.: TEST12345).",
    }),
});

type FormValues = z.infer<typeof formSchema>;

function configState(config: CapiConfig | null): { tone: Tone; label: string } {
  if (!config) return { tone: "neutral", label: "Não configurada" };
  if (!config.enabled) return { tone: "neutral", label: "Pausada" };
  if (config.last_error) return { tone: "warning", label: "Com erro" };
  if (config.test_event_code) return { tone: "info", label: "Modo de teste" };
  if (!config.last_sent_at) return { tone: "info", label: "Aguardando 1ª venda" };
  return { tone: "success", label: "Enviando vendas" };
}

export function CapiPanel() {
  const { workspace, canManage } = useWorkspace();
  const config = useCapiConfig(workspace.id);
  const [editing, setEditing] = useState(false);

  if (config.isPending) {
    return (
      <CapiCard state={configState(null)}>
        <div className="space-y-3 p-4">
          <Skeleton className="h-9 w-full" />
        </div>
      </CapiCard>
    );
  }
  if (config.isError) {
    return (
      <LoadError onRetry={() => config.refetch()} retrying={config.isFetching}>
        Não foi possível carregar a Conversions API.
      </LoadError>
    );
  }

  const current = config.data;
  return (
    <CapiCard state={configState(current)}>
      {current ? (
        <ConfiguredBody config={current} onEdit={() => setEditing(true)} />
      ) : (
        <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <p className="text-sm text-muted-foreground">
            Manda cada venda aprovada do checkout para o pixel da Meta, inclusive renovações e
            testes iniciados. A Meta passa a otimizar as campanhas com as vendas reais, e não só com
            o que o pixel do navegador consegue ver.
          </p>
          {canManage ? (
            <Button onClick={() => setEditing(true)}>Configurar</Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Peça a um owner ou admin para configurar.
            </p>
          )}
        </div>
      )}
      {canManage && (
        <>
          <Guide open={!current} />
          <ConfigDialog config={current} open={editing} onOpenChange={setEditing} />
        </>
      )}
    </CapiCard>
  );
}

function CapiCard({
  state,
  children,
}: {
  state: { tone: Tone; label: string };
  children: ReactNode;
}) {
  return (
    <section
      aria-label="Conversions API"
      className="overflow-hidden rounded-lg border border-border bg-surface"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <ProviderMark provider="meta" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">Conversions API</h3>
          <p className="text-xs text-muted-foreground">
            Vendas do checkout enviadas para o pixel da Meta
          </p>
        </div>
        <Status tone={state.tone}>{state.label}</Status>
      </header>
      {children}
    </section>
  );
}

function ConfiguredBody({ config, onEdit }: { config: CapiConfig; onEdit: () => void }) {
  const { workspace, canManage } = useWorkspace();
  const stats = useCapiStats(workspace.id, canManage);
  const test = useCapiTest(workspace.id);
  const backfill = useCapiBackfill(workspace.id);
  const remove = useDeleteCapiConfig(workspace.id);

  function runTest() {
    test.mutate(undefined, {
      onSuccess: (result) =>
        result.ok
          ? toast.success(
              "Evento de teste enviado. Confira em Gerenciador de Eventos › Testar eventos.",
            )
          : toast.error(capiErrorMessage(result.error)),
      onError: () => toast.error(capiErrorMessage(undefined)),
    });
  }

  return (
    <div className="space-y-4 p-4">
      {config.last_error && (
        <div className="flex items-start gap-2 rounded-md border border-warning/35 bg-warning/10 p-3 text-sm text-warning-strong">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            {config.last_error}
            {config.last_error_at &&
              ` (${formatDateTime(config.last_error_at, workspace.timezone)})`}
          </p>
        </div>
      )}
      {config.enabled && config.test_event_code && (
        <p className="rounded-md border border-info/30 bg-info/10 p-3 text-sm text-info-strong">
          Modo de teste ligado (código {config.test_event_code}): as vendas aparecem em Testar
          eventos. Depois de conferir, apague o código e salve.
        </p>
      )}

      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <Info label="Pixel" value={config.pixel_id} />
        <Info label="Site" value={config.event_source_url} />
        <Info
          label="Último envio"
          value={
            config.last_sent_at
              ? formatDateTime(config.last_sent_at, workspace.timezone)
              : "Nenhum ainda"
          }
        />
      </dl>

      {canManage && stats.data && (
        <p className="text-sm text-muted-foreground">
          Últimos 7 dias: {plural(stats.data.sent, "evento enviado", "eventos enviados")}
          {stats.data.pending > 0 && `, ${stats.data.pending} na fila`}
          {stats.data.failed > 0 && (
            <span className="text-danger-strong">
              , {plural(stats.data.failed, "com falha", "com falha")}
            </span>
          )}
          .
        </p>
      )}

      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil />
            Editar
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={runTest}
            loading={test.isPending}
            loadingText="Enviando…"
            disabled={!config.test_event_code}
            title={
              config.test_event_code ? undefined : "Cole um código de teste em Editar para testar."
            }
          >
            <FlaskConical />
            Enviar evento de teste
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!config.enabled}
            loading={backfill.isPending}
            loadingText="Enviando…"
            onClick={() =>
              backfill.mutate(undefined, {
                onSuccess: (count) =>
                  toast.success(
                    count > 0
                      ? `${plural(count, "venda dos últimos 7 dias entrou", "vendas dos últimos 7 dias entraram")} na fila de envio.`
                      : "Todas as vendas dos últimos 7 dias já foram para a Meta.",
                  ),
                onError: (error) => toast.error(friendlyError(error)),
              })
            }
          >
            <Upload />
            Enviar vendas dos últimos 7 dias
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link to={`/w/${workspace.id}/integracoes/logs?aba=meta`}>
              <ListChecks />
              Logs
            </Link>
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-danger-strong">
                <Unplug />
                Desconectar
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Desconectar a Conversions API?</AlertDialogTitle>
                <AlertDialogDescription>
                  O token é apagado e as próximas vendas não vão mais para a Meta. O que já foi
                  enviado continua lá.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-danger-hover"
                  loading={remove.isPending}
                  loadingText="Desconectando…"
                  onClick={(event) => {
                    event.preventDefault();
                    remove.mutate(undefined, {
                      onSuccess: () => toast.success("Conversions API desconectada."),
                      onError: (error) => toast.error(friendlyError(error)),
                    });
                  }}
                >
                  Desconectar
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="truncate text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}

function Guide({ open }: { open: boolean }) {
  return (
    <details className="group border-t border-border bg-surface-muted/40" open={open}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
        Como pegar o ID do pixel e o token
        <ChevronDown
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <ol className="space-y-3 border-t border-border px-4 py-3">
        {CAPI_GUIDE_STEPS.map((step, index) => (
          <li key={step} className="flex gap-3 text-sm text-muted-foreground">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] font-semibold text-foreground ring-1 ring-border">
              {index + 1}
            </span>
            <p className="min-w-0">{step}</p>
          </li>
        ))}
      </ol>
      <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
        {CAPI_CLICK_NOTE}
      </p>
    </details>
  );
}

function ConfigDialog({
  config,
  open,
  onOpenChange,
}: {
  config: CapiConfig | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Remonta a cada abertura para começar com os valores salvos. */}
      {open && <ConfigForm config={config} onOpenChange={onOpenChange} />}
    </Dialog>
  );
}

function ConfigForm({
  config,
  onOpenChange,
}: {
  config: CapiConfig | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { workspace } = useWorkspace();
  const save = useSaveCapiConfig(workspace.id);
  const [values, setValues] = useState<FormValues>({
    pixelId: config?.pixel_id ?? "",
    eventSourceUrl: config?.event_source_url ?? "",
    accessToken: "",
    testEventCode: config?.test_event_code ?? "",
  });
  const [flags, setFlags] = useState({
    enabled: config?.enabled ?? true,
    sendTrials: config?.send_trials ?? true,
    sendRefunds: config?.send_refunds ?? false,
  });
  const [errors, setErrors] = useState<FieldErrors<FormValues>>({});
  const hasToken = config?.has_token ?? false;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validate(formSchema, values);
    const nextErrors: FieldErrors<FormValues> = { ...(result.errors ?? {}) };
    if (!hasToken && !values.accessToken.trim())
      nextErrors.accessToken = "Cole o token de acesso da Conversions API.";
    setErrors(nextErrors);
    if (!result.data || Object.values(nextErrors).some(Boolean)) return;
    save.mutate(
      { ...result.data, ...flags },
      {
        onSuccess: () => {
          toast.success(
            config
              ? "Conversions API atualizada."
              : "Conversions API configurada. As próximas vendas vão para a Meta.",
          );
          onOpenChange(false);
        },
      },
    );
  }

  const set = (key: keyof FormValues) => (e: ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  return (
    <DialogContent>
      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col" noValidate>
        <DialogHeader>
          <DialogTitle>Conversions API da Meta</DialogTitle>
          <DialogDescription>
            O token fica criptografado no Supabase Vault. Depois de salvo, ninguém consegue ver pelo
            app.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-4">
            {save.isError && <LoadError>{friendlyError(save.error)}</LoadError>}
            <FormField
              label="ID do pixel (conjunto de dados)"
              error={errors.pixelId}
              hint="Só números, no Gerenciador de Eventos."
            >
              <Input
                inputMode="numeric"
                placeholder="1234567890123456"
                value={values.pixelId}
                onChange={set("pixelId")}
              />
            </FormField>
            <FormField
              label="Token de acesso"
              error={errors.accessToken}
              hint={
                hasToken
                  ? "Já existe um token salvo. Deixe em branco para manter."
                  : "Gerado em Configurações › API de Conversões."
              }
            >
              <Input
                type="password"
                autoComplete="off"
                placeholder={hasToken ? "••••••••" : "EAA..."}
                value={values.accessToken}
                onChange={set("accessToken")}
              />
            </FormField>
            <FormField
              label="URL do site"
              error={errors.eventSourceUrl}
              hint="Onde a compra acontece, ex.: https://seusite.com.br"
            >
              <Input
                type="url"
                placeholder="https://"
                value={values.eventSourceUrl}
                onChange={set("eventSourceUrl")}
              />
            </FormField>
            <FormField
              label="Código de teste (opcional)"
              error={errors.testEventCode}
              hint="Da aba Testar eventos. Com ele, os eventos vão para a tela de testes. Apague depois de conferir."
            >
              <Input
                placeholder="TEST12345"
                value={values.testEventCode}
                onChange={set("testEventCode")}
              />
            </FormField>
            <div className="grid gap-3 rounded-md border border-border p-3">
              <Toggle
                checked={flags.enabled}
                onChange={(enabled) => setFlags((f) => ({ ...f, enabled }))}
                label="Enviar vendas"
                hint="Cada venda aprovada vira um Purchase, inclusive as renovações."
              />
              <Toggle
                checked={flags.sendTrials}
                onChange={(sendTrials) => setFlags((f) => ({ ...f, sendTrials }))}
                label="Enviar testes iniciados (StartTrial)"
                hint="Assinatura com período de teste, antes da primeira cobrança."
              />
              <Toggle
                checked={flags.sendRefunds}
                onChange={(sendRefunds) => setFlags((f) => ({ ...f, sendRefunds }))}
                label="Enviar reembolsos como evento Refund"
                hint="Evento personalizado, útil para públicos e conversões personalizadas. A venda reembolsada antes do envio nunca vai como Purchase."
              />
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" loading={save.isPending} loadingText="Salvando…">
            <Send />
            Salvar
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
