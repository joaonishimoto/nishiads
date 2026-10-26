import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { AlertTriangle, Check, Copy, KeyRound, ListChecks, Plug, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
import { EmptyState, LoadError, PageHeader, PageSkeleton, Panel, Status } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
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
import { friendlyError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { validate, type FieldErrors } from "@/lib/form";
import { META_URL_PARAMETERS } from "@/lib/utm";
import type { CheckoutProvider } from "@/types/database";

type ProviderKey = keyof typeof PROVIDERS;

const createSchema = z.object({
  provider: z.enum(["kiwify", "hotmart", "stripe", "eduzz"]),
  name: z.string().trim().min(1, "Dê um nome à integração.").max(80, "Use no máximo 80 caracteres."),
});

export function IntegrationsPage() {
  const { workspace, canManage } = useWorkspace();
  const integrations = useIntegrations(workspace.id);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrações"
        subtitle="Checkouts que enviam as vendas e os parâmetros para os anúncios."
        actions={
          <>
            {canManage && (
              <Button variant="outline" asChild>
                <Link to={`/w/${workspace.id}/integracoes/logs`}>
                  <ListChecks />
                  Logs de integração
                </Link>
              </Button>
            )}
            {canManage && (
              <Button onClick={() => setCreating(true)}>
                <Plus />
                Conectar checkout
              </Button>
            )}
          </>
        }
      />

      {integrations.isPending ? (
        <PageSkeleton rows={2} />
      ) : integrations.isError ? (
        <LoadError onRetry={() => integrations.refetch()} retrying={integrations.isFetching}>
          Não foi possível carregar as integrações.
        </LoadError>
      ) : integrations.data.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="Nenhum checkout conectado"
          description={
            canManage
              ? "Conecte a Kiwify ou a Stripe para receber cada venda com a campanha, o conjunto e o criativo de origem."
              : "Peça a um owner ou admin para conectar o checkout."
          }
          action={canManage && <Button onClick={() => setCreating(true)}>Conectar checkout</Button>}
        />
      ) : (
        <div className="space-y-4">
          {integrations.data.map((integration) => (
            <IntegrationCard key={integration.id} integration={integration} />
          ))}
        </div>
      )}

      <Panel
        title="Como conectar uma conta"
        description="Vale para a primeira conta e para as próximas. Cada conta de checkout é uma integração, com URL e chaves próprias."
      >
        <div className="space-y-3 p-4">
          {AVAILABLE_PROVIDERS.map((provider) => (
            <ProviderGuide key={provider.label} provider={provider} withCreateStep />
          ))}
        </div>
      </Panel>

      <Panel
        title="Parâmetros de URL dos anúncios"
        description="Cole no campo “Parâmetros de URL” de cada anúncio no Gerenciador da Meta."
      >
        <div className="p-4">
          <CopyField value={META_URL_PARAMETERS} label="parâmetros de URL" />
        </div>
      </Panel>

      {canManage && <CreateIntegrationDialog open={creating} onOpenChange={setCreating} />}
    </div>
  );
}

const AVAILABLE_PROVIDERS = Object.values(PROVIDERS).filter((p) => p.available && p.steps.length > 0);

/** Passo a passo de um provedor. Com `withCreateStep`, começa pela criação da integração no Nishiads. */
function ProviderGuide({
  provider,
  open,
  withCreateStep = false,
}: {
  provider: (typeof PROVIDERS)[ProviderKey];
  open?: boolean;
  withCreateStep?: boolean;
}) {
  const steps = withCreateStep
    ? [
        `Aqui no Nishiads, clique em Conectar checkout, escolha ${provider.label} e dê um nome que identifique a conta (ex.: ${provider.label} FreelaPro). Copie a URL do webhook que aparece no card.`,
        ...provider.steps,
      ]
    : provider.steps;
  return (
    <details className="rounded-md border border-border" open={open}>
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-foreground">
        Como configurar na {provider.label}
      </summary>
      <ol className="list-decimal space-y-1.5 border-t border-border py-3 pl-8 pr-3 text-sm text-muted-foreground">
        {steps.map((step) => (
          <GuideStepItem key={typeof step === "string" ? step : step.text} step={step} />
        ))}
      </ol>
      {provider.note && (
        <p className="border-t border-border px-3 py-3 text-sm text-muted-foreground">{provider.note}</p>
      )}
    </details>
  );
}

function GuideStepItem({ step }: { step: GuideStep }) {
  if (typeof step === "string") return <li>{step}</li>;
  return (
    <li>
      {step.text}
      <ul className="mt-2 flex flex-wrap gap-2">
        {step.copyItems.map((item) => (
          <li key={item}>
            <CopyChip value={item} />
          </li>
        ))}
      </ul>
    </li>
  );
}

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${value} copiado.`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copiar ${value}`}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-muted px-2 py-1 font-mono text-xs text-foreground transition-colors hover:bg-accent"
    >
      {value}
      {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
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
  const url = webhookUrl(integration.provider, integration.webhook_url_token);

  return (
    <Panel
      title={integration.name}
      description={`${provider?.label ?? integration.provider} · ${
        integration.last_event_at
          ? `último evento ${formatDateTime(integration.last_event_at, workspace.timezone)}`
          : "nenhum evento recebido ainda"
      }`}
      action={
        <Status tone={!integration.active ? "neutral" : integration.has_secret ? "success" : "warning"}>
          {!integration.active
            ? "Desativada"
            : integration.has_secret
              ? "Ativa"
              : provider?.secretFields
                ? "Faltam as chaves"
                : "Falta o token"}
        </Status>
      }
    >
      {canManage ? (
        <div className="space-y-4 p-4">
          {!integration.has_secret && (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning-strong">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>
                Sem {secretNoun}, os webhooks são recusados. Siga o passo a passo e salve {secretNoun} da{" "}
                {provider?.label}.
              </p>
            </div>
          )}
          <div className="grid gap-1.5">
            <p className="text-sm font-medium text-foreground">URL do webhook</p>
            <CopyField value={url} label="URL do webhook" />
          </div>
          {provider && provider.steps.length > 0 && (
            <ProviderGuide provider={provider} open={!integration.has_secret} />
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch
                checked={integration.active}
                disabled={update.isPending}
                onCheckedChange={(active) =>
                  update.mutate(
                    { id: integration.id, active },
                    {
                      onSuccess: () => toast.success(active ? "Integração ativada." : "Integração desativada."),
                      onError: (error) => toast.error(friendlyError(error)),
                    },
                  )
                }
              />
              Receber vendas
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setSettingSecret(true)}>
                <KeyRound />
                {provider?.secretFields
                  ? integration.has_secret
                    ? "Trocar chaves"
                    : "Salvar chaves"
                  : integration.has_secret
                    ? "Trocar token"
                    : "Salvar token"}
              </Button>
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
                      Os próximos webhooks desta URL serão recusados. As vendas já recebidas continuam no Nishiads.
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
          </div>
        </div>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {integration.active ? "Recebendo vendas." : "Desativada."} Só owners e admins veem a URL e o token.
        </p>
      )}
      <SecretDialog
        integration={integration}
        open={settingSecret}
        onOpenChange={setSettingSecret}
      />
    </Panel>
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
      fields.map((f) => [f.key, f.pattern.test(trimmed[f.key] ?? "") ? undefined : f.patternMessage]),
    );
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    // Vários segredos (Stripe) vão juntos, como JSON, para o mesmo item do Vault.
    const secret = multiple ? JSON.stringify(trimmed) : (trimmed[fields[0]!.key] ?? "");
    setSecret.mutate(
      { integrationId: integration.id, secret },
      {
        onSuccess: () => {
          toast.success(multiple ? "Chaves salvas com criptografia." : "Token salvo com criptografia.");
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
              {multiple ? "Ficam criptografadas" : "Fica criptografado"} no Supabase Vault. Depois de salvo, ninguém
              consegue ver pelo app.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-4">
              {setSecret.isError && <LoadError>{friendlyError(setSecret.error)}</LoadError>}
              {fields.map((field) => (
                <FormField key={field.key} label={field.label} error={errors[field.key]} hint={field.hint || undefined}>
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

function CreateIntegrationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { workspace } = useWorkspace();
  const create = useCreateIntegration(workspace.id);
  const [values, setValues] = useState<{ provider: ProviderKey; name: string }>({ provider: "kiwify", name: "Kiwify" });
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col" noValidate>
          <DialogHeader>
            <DialogTitle>Conectar checkout</DialogTitle>
            <DialogDescription>
              Criamos uma URL de webhook exclusiva. Você cola essa URL no checkout e salva as chaves dele aqui.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-4">
              {create.isError && <LoadError>{friendlyError(create.error)}</LoadError>}
              <FormField label="Plataforma" error={errors.provider}>
                <Select
                  value={values.provider}
                  onValueChange={(provider) =>
                    setValues({ provider: provider as ProviderKey, name: PROVIDERS[provider as ProviderKey].label })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PROVIDERS) as ProviderKey[]).map((key) => (
                      <SelectItem key={key} value={key} disabled={!PROVIDERS[key].available}>
                        {PROVIDERS[key].label}
                        {!PROVIDERS[key].available && " (em breve)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Nome" error={errors.name} hint="Ajuda a diferenciar várias contas da mesma plataforma.">
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
    </Dialog>
  );
}
