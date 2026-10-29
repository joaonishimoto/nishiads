import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CheckCircle2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
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
import { LoadError, Status } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import {
  trackingSnippet,
  useCreateTrackingSource,
  useDeleteTrackingSource,
  useTrackingSources,
  useTrackingSummary,
  useUpdateTrackingSource,
  type TrackingSource,
  type TrackingSummaryRow,
} from "@/features/tracking/api";
import { friendlyError } from "@/lib/errors";
import { formatDateTime, plural } from "@/lib/format";

const CALL_EXAMPLE = "nishistack('cadastro', { id: usuario.id })";

/** Sites e apps com o script do Nishistack Ads: cadastros e outros eventos por anúncio. */
export function TrackingPanel() {
  const { workspace, canManage } = useWorkspace();
  const sources = useTrackingSources(workspace.id);
  const summary = useTrackingSummary(workspace.id, (sources.data?.length ?? 0) > 0);

  if (sources.isPending) return <Skeleton className="h-40 rounded-lg" />;
  if (sources.isError) {
    return (
      <LoadError onRetry={() => sources.refetch()} retrying={sources.isFetching}>
        Não foi possível carregar o rastreamento.
      </LoadError>
    );
  }

  return (
    <div className="space-y-4">
      {sources.data.length === 0 && (
        <div className="rounded-lg border border-dashed border-border-strong bg-surface-muted/40 p-4 text-sm text-muted-foreground">
          <p>
            Cadastre seu site ou app para ver cadastros, testes e outros eventos por criativo, sem
            depender da Meta. Você cola um código no site e chama{" "}
            <code className="font-mono text-xs">{CALL_EXAMPLE}</code> quando a pessoa se cadastra.
          </p>
          {!canManage && <p className="mt-2">Peça a um owner ou admin para cadastrar.</p>}
        </div>
      )}
      {sources.data.map((source) => (
        <SourceCard key={source.id} source={source} summary={summary.data ?? []} />
      ))}
      {canManage && <CreateSourceForm first={sources.data.length === 0} />}
    </div>
  );
}

function CreateSourceForm({ first }: { first: boolean }) {
  const { workspace } = useWorkspace();
  const create = useCreateTrackingSource(workspace.id);
  const [name, setName] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value) return;
    create.mutate(value, {
      onSuccess: () => {
        setName("");
        toast.success("Site cadastrado. Copie o código e cole no site.");
      },
      onError: (error) => toast.error(friendlyError(error)),
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
        placeholder={first ? "Nome do site ou app, ex.: Drinfy" : "Outro site ou app"}
        aria-label="Nome do site ou app"
        className="sm:max-w-72"
      />
      <Button type="submit" size="sm" loading={create.isPending} disabled={!name.trim()}>
        <Plus />
        Cadastrar site
      </Button>
    </form>
  );
}

function SourceCard({
  source,
  summary,
}: {
  source: TrackingSource;
  summary: TrackingSummaryRow[];
}) {
  const { workspace, canManage } = useWorkspace();
  const update = useUpdateTrackingSource(workspace.id);
  const remove = useDeleteTrackingSource(workspace.id);
  const state = !source.active
    ? { tone: "neutral" as const, label: "Pausado" }
    : source.last_event_at
      ? { tone: "success" as const, label: "Recebendo eventos" }
      : { tone: "info" as const, label: "Aguardando 1º evento" };

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-surface">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{source.name}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {source.last_event_at
              ? `último evento ${formatDateTime(source.last_event_at, workspace.timezone)}`
              : "nenhum evento recebido ainda"}
          </p>
        </div>
        <Status tone={state.tone}>
          {state.tone === "success" && <CheckCircle2 aria-hidden />}
          {state.label}
        </Status>
      </header>

      <div className="space-y-4 p-4">
        <div className="grid gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            1. Cole no {"<head>"} de todas as páginas (site e app)
          </p>
          <CopyField value={trackingSnippet(source.public_key)} label="código do site" />
          <p className="text-xs text-muted-foreground">
            Guarda o UTM e o fbclid de quem chega pelo anúncio por 90 dias, no domínio principal
            (vale para site.com e app.site.com).
          </p>
        </div>
        <div className="grid gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            2. Chame quando a pessoa se cadastrar
          </p>
          <CopyField value={CALL_EXAMPLE} label="chamada do cadastro" />
          <p className="text-xs text-muted-foreground">
            O id evita contar o mesmo cadastro duas vezes. Use outros nomes para outros eventos:{" "}
            <code className="font-mono">teste</code>, <code className="font-mono">compra</code>,{" "}
            <code className="font-mono">lead</code>. Em Campanhas, ligue as colunas “(rastreio)” no
            template.
          </p>
        </div>
        {summary.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Últimos 7 dias</p>
            <ul className="divide-y divide-border rounded-md border border-border text-sm">
              {summary.map((row) => (
                <li
                  key={row.event}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <code className="font-mono text-xs text-foreground">{row.event}</code>
                  <span className="text-xs text-muted-foreground">
                    {plural(row.total, "evento", "eventos")}, {row.matched} com anúncio · último{" "}
                    {formatDateTime(row.last, workspace.timezone)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {canManage && (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-muted/30 px-4 py-3">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              checked={source.active}
              disabled={update.isPending}
              onCheckedChange={(active) =>
                update.mutate(
                  { id: source.id, active },
                  {
                    onSuccess: () =>
                      toast.success(active ? "Rastreamento ativado." : "Rastreamento pausado."),
                    onError: (error) => toast.error(friendlyError(error)),
                  },
                )
              }
            />
            Receber eventos
          </label>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-danger-strong">
                <Trash2 />
                Excluir
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Excluir “{source.name}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  Os eventos já recebidos deste site também são apagados, e os próximos serão
                  recusados. Para só parar de receber, desligue “Receber eventos”.
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
                    remove.mutate(source.id, {
                      onSuccess: () => toast.success("Site excluído."),
                      onError: (error) => toast.error(friendlyError(error)),
                    });
                  }}
                >
                  Excluir site
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </footer>
      )}
    </article>
  );
}
