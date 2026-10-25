import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { AlertTriangle, KeyRound, ListChecks, Plug, Plus, Trash2 } from "lucide-react";
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
import { PROVIDERS } from "@/features/integrations/providers";
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

const secretSchema = z.object({
  secret: z.string().trim().min(8, "O token precisa ter pelo menos 8 caracteres.").max(500, "Token muito longo."),
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
              ? "Conecte a Kiwify para receber cada venda com a campanha, o conjunto e o criativo de origem."
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

function IntegrationCard({ integration }: { integration: Integration }) {
  const { workspace, canManage } = useWorkspace();
  const update = useUpdateIntegration(workspace.id);
  const remove = useDeleteIntegration(workspace.id);
  const [settingSecret, setSettingSecret] = useState(false);
  const provider = PROVIDERS[integration.provider as ProviderKey];
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
          {!integration.active ? "Desativada" : integration.has_secret ? "Ativa" : "Falta o token"}
        </Status>
      }
    >
      {canManage ? (
        <div className="space-y-4 p-4">
          {!integration.has_secret && (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning-strong">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>Sem o token, os webhooks são recusados. Siga os passos abaixo e salve o token da {provider?.label}.</p>
            </div>
          )}
          <div className="grid gap-1.5">
            <p className="text-sm font-medium text-foreground">URL do webhook</p>
            <CopyField value={url} label="URL do webhook" />
          </div>
          {provider && provider.steps.length > 0 && (
            <details className="rounded-md border border-border" open={!integration.has_secret}>
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-foreground">
                Como configurar na {provider.label}
              </summary>
              <ol className="list-decimal space-y-1.5 border-t border-border py-3 pl-8 pr-3 text-sm text-muted-foreground">
                {provider.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </details>
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
                {integration.has_secret ? "Trocar token" : "Salvar token"}
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
  const [secret, setSecretValue] = useState("");
  const [error, setError] = useState<string | undefined>();
  const provider = PROVIDERS[integration.provider as ProviderKey];

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validate(secretSchema, { secret });
    setError(result.errors?.secret);
    if (!result.data) return;
    setSecret.mutate(
      { integrationId: integration.id, secret: result.data.secret },
      {
        onSuccess: () => {
          toast.success("Token salvo com criptografia.");
          setSecretValue("");
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
              Fica criptografado no Supabase Vault. Depois de salvo, ninguém consegue ver o token pelo app.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-4">
              {setSecret.isError && <LoadError>{friendlyError(setSecret.error)}</LoadError>}
              <FormField label={provider?.secretLabel ?? "Token"} error={error} hint={provider?.secretHint}>
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder="Cole o token aqui"
                  value={secret}
                  onChange={(e) => setSecretValue(e.target.value)}
                />
              </FormField>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={setSecret.isPending} loadingText="Salvando…">
              Salvar token
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
              Criamos uma URL de webhook exclusiva. Você cola essa URL no checkout e salva o token dele aqui.
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
