import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  KeyRound,
  ListChecks,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { CopyField } from "@/components/app/copy-field";
import { FormField } from "@/components/app/form-field";
import { LoadError, PageHeader, Status } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { MetaAdsPanel } from "@/features/meta/meta-ads-panel";
import { CapiPanel } from "@/features/meta/capi-panel";
import { useAdAccounts, useMetaConnections } from "@/features/meta/api";
import {
  useCreateIntegration,
  useDeleteIntegration,
  useIntegrations,
  useSetIntegrationSecret,
  useUpdateIntegration,
  webhookUrl,
  type Integration,
} from "@/features/integrations/api";
import { PROVIDERS, type GuideStep, type SecretField } from "@/features/integrations/providers";
import { ProviderMark } from "@/features/integrations/provider-mark";
import { friendlyError } from "@/lib/errors";
import { formatDateTime, plural } from "@/lib/format";
import { validate, type FieldErrors } from "@/lib/form";
import { META_URL_PARAMETERS } from "@/lib/utm";
import { cn } from "@/lib/utils";
import type { CheckoutProvider } from "@/types/database";

type ProviderKey = keyof typeof PROVIDERS;

const createSchema = z.object({
  provider: z.enum(["kiwify", "hotmart", "stripe", "eduzz"]),
  name: z
    .string()
    .trim()
    .min(1, "Dê um nome à integração.")
    .max(80, "Use no máximo 80 caracteres."),
});

export function IntegrationsPage() {
  const { workspace, canManage } = useWorkspace();
  const [creating, setCreating] = useState<ProviderKey | null>(null);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Integrações"
        subtitle="Anúncios de um lado, checkouts do outro. Com os dois conectados, cada venda chega com o criativo que a trouxe."
        actions={
          <>
            {canManage && (
              <Button variant="outline" asChild>
                <Link to={`/w/${workspace.id}/integracoes/logs`}>
                  <ListChecks />
                  Logs
                </Link>
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link to={`/w/${workspace.id}/ajuda`}>
                <BookOpen />
                Documentação
              </Link>
            </Button>
          </>
        }
      />

      <SetupSteps onConnectCheckout={() => setCreating("kiwify")} />

      <Section
        id="anuncios"
        title="Anúncios"
        description="De onde vêm gasto, impressões e criativos para calcular ROAS e CPA."
      >
        <MetaAdsPanel />
        <UrlParametersCard />
        <CapiPanel />
      </Section>

      <Section
        id="checkouts"
        title="Checkouts"
        description="Cada conta de checkout é uma integração, com URL de webhook e chaves próprias."
        action={
          canManage && (
            <Button size="sm" onClick={() => setCreating("kiwify")}>
              <Plus />
              Conectar checkout
            </Button>
          )
        }
      >
        <CheckoutList onCreate={setCreating} />
      </Section>

      {canManage && (
        <CreateIntegrationDialog
          provider={creating}
          onOpenChange={(open) => !open && setCreating(null)}
        />
      )}
    </div>
  );
}

function Section({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string;
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Os três elos da atribuição, com o estado real de cada um. */
function SetupSteps({ onConnectCheckout }: { onConnectCheckout: () => void }) {
  const { workspace, canManage } = useWorkspace();
  const connections = useMetaConnections(workspace.id);
  const accounts = useAdAccounts(workspace.id);
  const integrations = useIntegrations(workspace.id);

  if (connections.isPending || accounts.isPending || integrations.isPending) {
    return (
      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
    );
  }

  const tracked = accounts.data?.filter((a) => a.is_tracked).length ?? 0;
  const metaReconnect = connections.data?.some((c) => c.status === "needs_reconnect") ?? false;
  const metaDone = (connections.data?.length ?? 0) > 0 && tracked > 0 && !metaReconnect;
  const checkouts = integrations.data ?? [];
  const ready = checkouts.filter((i) => i.active && i.has_secret).length;
  const missing = checkouts.filter((i) => i.active && !i.has_secret).length;
  const lastEvent = checkouts
    .map((i) => i.last_event_at)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1);

  return (
    <ol className="grid gap-3 md:grid-cols-3">
      <StepCard
        index={1}
        title="Meta Ads"
        done={metaDone}
        warning={metaReconnect}
        status={
          metaReconnect
            ? "Acesso expirado: reconecte"
            : metaDone
              ? plural(tracked, "conta acompanhada", "contas acompanhadas")
              : (connections.data?.length ?? 0) > 0
                ? "Escolha as contas para acompanhar"
                : "Ainda não conectada"
        }
        action={
          !metaDone && (
            <StepLink href="#anuncios">{metaReconnect ? "Reconectar" : "Conectar"}</StepLink>
          )
        }
      />
      <StepCard
        index={2}
        title="Checkout"
        done={ready > 0 && missing === 0}
        warning={missing > 0}
        status={
          ready === 0 && missing === 0
            ? "Nenhum checkout conectado"
            : missing > 0
              ? `${plural(missing, "integração sem chave", "integrações sem chave")}`
              : lastEvent
                ? `Último evento ${formatDateTime(lastEvent, workspace.timezone)}`
                : `${plural(ready, "checkout pronto", "checkouts prontos")}, aguardando o 1º evento`
        }
        action={
          missing > 0 ? (
            <StepLink href="#checkouts">Salvar chaves</StepLink>
          ) : (
            ready === 0 &&
            canManage && (
              <button type="button" onClick={onConnectCheckout} className={stepLinkClass}>
                Conectar
              </button>
            )
          )
        }
      />
      <StepCard
        index={3}
        title="Parâmetros nos anúncios"
        status="Cole em “Parâmetros de URL” de cada anúncio"
        action={<CopyParamsButton />}
      />
    </ol>
  );
}

const stepLinkClass =
  "inline-flex items-center text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm";

function StepLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className={stepLinkClass}>
      {children}
    </a>
  );
}

function StepCard({
  index,
  title,
  status,
  done = false,
  warning = false,
  action,
}: {
  index: number;
  title: string;
  status: string;
  done?: boolean;
  warning?: boolean;
  action?: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex flex-col justify-between gap-3 rounded-lg border bg-surface p-4 md:min-h-28",
        warning ? "border-warning/40" : done ? "border-success/30" : "border-border",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            done && "bg-success/15 text-success-strong",
            warning && "bg-warning/15 text-warning-strong",
            !done && !warning && "bg-muted text-muted-foreground",
          )}
        >
          {done ? (
            <Check className="h-4 w-4" aria-hidden />
          ) : warning ? (
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          ) : (
            index
          )}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{status}</p>
        </div>
      </div>
      {action && <div className="pl-10">{action}</div>}
    </li>
  );
}

function useCopy(value: string, message = "Copiado.") {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(message);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  }
  return { copied, copy };
}

function CopyParamsButton() {
  const { copied, copy } = useCopy(
    META_URL_PARAMETERS,
    "Parâmetros copiados. Cole no anúncio, na Meta.",
  );
  return (
    <button type="button" onClick={copy} className={cn(stepLinkClass, "gap-1.5")}>
      {copied ? (
        <Check className="h-4 w-4" aria-hidden />
      ) : (
        <Copy className="h-4 w-4" aria-hidden />
      )}
      {copied ? "Copiado" : "Copiar parâmetros"}
    </button>
  );
}

function UrlParametersCard() {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">Parâmetros de URL dos anúncios</p>
        <p className="text-xs text-muted-foreground">
          Gerenciador de Anúncios › anúncio › Rastreamento › Parâmetros de URL
        </p>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        A Meta troca cada {"{{...}}"} pelo nome e id reais no clique. É o que liga a venda à
        campanha, ao conjunto e ao criativo.
      </p>
      <div className="mt-3">
        <CopyField value={META_URL_PARAMETERS} label="parâmetros de URL" />
      </div>
    </div>
  );
}

const PROVIDER_ORDER: ProviderKey[] = ["kiwify", "stripe", "hotmart", "eduzz"];

function CheckoutList({ onCreate }: { onCreate: (provider: ProviderKey) => void }) {
  const { workspace, canManage } = useWorkspace();
  const integrations = useIntegrations(workspace.id);

  if (integrations.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-40 rounded-lg" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    );
  }
  if (integrations.isError) {
    return (
      <LoadError onRetry={() => integrations.refetch()} retrying={integrations.isFetching}>
        Não foi possível carregar as integrações.
      </LoadError>
    );
  }

  return (
    <div className="space-y-4">
      {integrations.data.length === 0 && !canManage && (
        <p className="rounded-lg border border-dashed border-border-strong bg-surface-muted/40 p-6 text-center text-sm text-muted-foreground">
          Nenhum checkout conectado. Peça a um owner ou admin para conectar.
        </p>
      )}
      {integrations.data.map((integration) => (
        <IntegrationCard key={integration.id} integration={integration} />
      ))}
      {canManage && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {integrations.data.length === 0 ? "Escolha a plataforma" : "Adicionar outra conta"}
          </p>
          <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {PROVIDER_ORDER.map((key) => {
              const provider = PROVIDERS[key];
              return (
                <li key={key}>
                  <button
                    type="button"
                    disabled={!provider.available}
                    onClick={() => onCreate(key)}
                    className="flex h-full w-full items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border disabled:hover:bg-surface"
                  >
                    <ProviderMark provider={key} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">
                        {provider.label}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {provider.available ? "Conectar" : "Em breve"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Passo a passo de um provedor, recolhível. */
function ProviderGuide({
  provider,
  open,
}: {
  provider: (typeof PROVIDERS)[ProviderKey];
  open?: boolean;
}) {
  return (
    <details className="group rounded-md border border-border bg-surface-muted/40" open={open}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
        Passo a passo na {provider.label}
        <ChevronDown
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <ol className="space-y-3 border-t border-border px-3 py-3">
        {provider.steps.map((step, index) => (
          <GuideStepItem
            key={typeof step === "string" ? step : step.text}
            step={step}
            index={index + 1}
          />
        ))}
      </ol>
      {provider.note && (
        <p className="border-t border-border px-3 py-3 text-sm text-muted-foreground">
          {provider.note}
        </p>
      )}
    </details>
  );
}

function GuideStepItem({ step, index }: { step: GuideStep; index: number }) {
  const text = typeof step === "string" ? step : step.text;
  return (
    <li className="flex gap-3 text-sm text-muted-foreground">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] font-semibold text-foreground ring-1 ring-border">
        {index}
      </span>
      <div className="min-w-0">
        <p>{text}</p>
        {typeof step !== "string" && (
          <ul className="mt-2 flex flex-wrap gap-2">
            {step.copyItems.map((item) => (
              <li key={item}>
                <CopyChip value={item} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function CopyChip({ value }: { value: string }) {
  const { copied, copy } = useCopy(value, `${value} copiado.`);
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copiar ${value}`}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-foreground transition-colors hover:bg-accent"
    >
      {value}
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

function IntegrationCard({ integration }: { integration: Integration }) {
  const { workspace, canManage } = useWorkspace();
  const update = useUpdateIntegration(workspace.id);
  const remove = useDeleteIntegration(workspace.id);
  const [settingSecret, setSettingSecret] = useState(false);
  const provider = PROVIDERS[integration.provider as ProviderKey];
  const secretNoun = provider?.secretFields ? "as chaves" : "o token";
  const saveLabel = provider?.secretFields
    ? integration.has_secret
      ? "Trocar chaves"
      : "Salvar chaves"
    : integration.has_secret
      ? "Trocar token"
      : "Salvar token";
  const url = webhookUrl(integration.provider, integration.webhook_url_token);
  const state = !integration.active
    ? { tone: "neutral" as const, label: "Pausada" }
    : integration.has_secret
      ? integration.last_event_at
        ? { tone: "success" as const, label: "Recebendo vendas" }
        : { tone: "info" as const, label: "Aguardando 1º evento" }
      : {
          tone: "warning" as const,
          label: provider?.secretFields ? "Faltam as chaves" : "Falta o token",
        };

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-surface">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <ProviderMark provider={integration.provider} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{integration.name}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {provider?.label ?? integration.provider} ·{" "}
            {integration.last_event_at
              ? `último evento ${formatDateTime(integration.last_event_at, workspace.timezone)}`
              : "nenhum evento recebido ainda"}
          </p>
        </div>
        <Status tone={state.tone}>
          {state.tone === "success" && <CheckCircle2 aria-hidden />}
          {state.label}
        </Status>
      </header>

      {canManage ? (
        <>
          <div className="space-y-4 p-4">
            {!integration.has_secret && (
              <div className="flex flex-col gap-3 rounded-md border border-warning/35 bg-warning/10 p-3 text-sm text-warning-strong sm:flex-row sm:items-center sm:justify-between">
                <p className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  Sem {secretNoun}, os webhooks são recusados. Siga o passo a passo e salve{" "}
                  {secretNoun} da {provider?.label}.
                </p>
                <Button
                  size="sm"
                  className="shrink-0 self-start sm:self-auto"
                  onClick={() => setSettingSecret(true)}
                >
                  <KeyRound />
                  {saveLabel}
                </Button>
              </div>
            )}
            <div className="grid gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">URL do webhook</p>
              <CopyField value={url} label="URL do webhook" />
            </div>
            {provider && provider.steps.length > 0 && (
              <ProviderGuide provider={provider} open={!integration.has_secret} />
            )}
          </div>
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-muted/30 px-4 py-3">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch
                checked={integration.active}
                disabled={update.isPending}
                onCheckedChange={(active) =>
                  update.mutate(
                    { id: integration.id, active },
                    {
                      onSuccess: () =>
                        toast.success(active ? "Integração ativada." : "Integração pausada."),
                      onError: (error) => toast.error(friendlyError(error)),
                    },
                  )
                }
              />
              Receber vendas
            </label>
            <div className="flex flex-wrap gap-2">
              {integration.has_secret && (
                <Button variant="outline" size="sm" onClick={() => setSettingSecret(true)}>
                  <KeyRound />
                  {saveLabel}
                </Button>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-danger-strong">
                    <Trash2 />
                    Excluir
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Excluir “{integration.name}”?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Os próximos webhooks desta URL serão recusados. As vendas já recebidas
                      continuam no Nishistack - ADS.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-danger-hover"
                      loading={remove.isPending}
                      loadingText="Excluindo…"
                      onClick={(event) => {
                        event.preventDefault();
                        remove.mutate(integration.id, {
                          onSuccess: () => toast.success("Integração excluída."),
                          onError: (error) => toast.error(friendlyError(error)),
                        });
                      }}
                    >
                      Excluir integração
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </footer>
        </>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {integration.active ? "Recebendo vendas." : "Pausada."} Só owners e admins veem a URL e as
          chaves.
        </p>
      )}
      <SecretDialog
        integration={integration}
        open={settingSecret}
        onOpenChange={setSettingSecret}
      />
    </article>
  );
}

function SecretDialog({
  integration,
  open,
  onOpenChange,
}: {
  integration: Integration;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { workspace } = useWorkspace();
  const setSecret = useSetIntegrationSecret(workspace.id);
  const provider = PROVIDERS[integration.provider as ProviderKey];
  const fields: SecretField[] = provider?.secretFields ?? [
    {
      key: "secret",
      label: provider?.secretLabel ?? "Token",
      hint: provider?.secretHint ?? "",
      placeholder: "Cole o token aqui",
      pattern: /^.{8,500}$/,
      patternMessage: "O token precisa ter entre 8 e 500 caracteres.",
    },
  ];
  const multiple = fields.length > 1;
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = Object.fromEntries(fields.map((f) => [f.key, (values[f.key] ?? "").trim()]));
    const nextErrors = Object.fromEntries(
      fields.map((f) => [
        f.key,
        f.pattern.test(trimmed[f.key] ?? "") ? undefined : f.patternMessage,
      ]),
    );
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    // Vários segredos (Stripe) vão juntos, como JSON, para o mesmo item do Vault.
    const secret = multiple ? JSON.stringify(trimmed) : (trimmed[fields[0]!.key] ?? "");
    setSecret.mutate(
      { integrationId: integration.id, secret },
      {
        onSuccess: () => {
          toast.success(
            multiple ? "Chaves salvas com criptografia." : "Token salvo com criptografia.",
          );
          setValues({});
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col" noValidate>
          <DialogHeader>
            <DialogTitle>{provider?.secretLabel ?? "Token"}</DialogTitle>
            <DialogDescription>
              {multiple ? "Ficam criptografadas" : "Fica criptografado"} no Supabase Vault. Depois
              de salvo, ninguém consegue ver pelo app.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-4">
              {setSecret.isError && <LoadError>{friendlyError(setSecret.error)}</LoadError>}
              {fields.map((field) => (
                <FormField
                  key={field.key}
                  label={field.label}
                  error={errors[field.key]}
                  hint={field.hint || undefined}
                >
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder={field.placeholder}
                    value={values[field.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  />
                </FormField>
              ))}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={setSecret.isPending} loadingText="Salvando…">
              {multiple ? "Salvar chaves" : "Salvar token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateIntegrationDialog({
  provider,
  onOpenChange,
}: {
  provider: ProviderKey | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={provider !== null} onOpenChange={onOpenChange}>
      {/* Remonta a cada abertura para começar com a plataforma escolhida. */}
      {provider && (
        <CreateIntegrationForm
          key={provider}
          initialProvider={provider}
          onOpenChange={onOpenChange}
        />
      )}
    </Dialog>
  );
}

function CreateIntegrationForm({
  initialProvider,
  onOpenChange,
}: {
  initialProvider: ProviderKey;
  onOpenChange: (open: boolean) => void;
}) {
  const { workspace } = useWorkspace();
  const create = useCreateIntegration(workspace.id);
  const [values, setValues] = useState<{ provider: ProviderKey; name: string }>({
    provider: initialProvider,
    name: PROVIDERS[initialProvider].label,
  });
  const [errors, setErrors] = useState<FieldErrors<typeof values>>({});

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validate(createSchema, values);
    setErrors(result.errors ?? {});
    if (!result.data) return;
    create.mutate(
      { provider: result.data.provider as CheckoutProvider, name: result.data.name },
      {
        onSuccess: () => {
          toast.success("Integração criada. Agora configure o webhook no checkout.");
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <DialogContent>
      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col" noValidate>
        <DialogHeader>
          <DialogTitle>Conectar checkout</DialogTitle>
          <DialogDescription>
            Criamos uma URL de webhook exclusiva. Você cola essa URL no checkout e salva as chaves
            dele aqui.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-4">
            {create.isError && <LoadError>{friendlyError(create.error)}</LoadError>}
            <FormField label="Plataforma" error={errors.provider}>
              <Select
                value={values.provider}
                onValueChange={(provider) =>
                  setValues({
                    provider: provider as ProviderKey,
                    name: PROVIDERS[provider as ProviderKey].label,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione…" />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_ORDER.map((key) => (
                    <SelectItem key={key} value={key} disabled={!PROVIDERS[key].available}>
                      {PROVIDERS[key].label}
                      {!PROVIDERS[key].available && " (em breve)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label="Nome"
              error={errors.name}
              hint="Ajuda a diferenciar várias contas da mesma plataforma."
            >
              <Input
                placeholder="Ex.: Kiwify principal"
                value={values.name}
                maxLength={80}
                onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" loading={create.isPending} loadingText="Criando…">
            Criar integração
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
