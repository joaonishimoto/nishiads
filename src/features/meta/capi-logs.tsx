import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { RotateCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, LoadError, PageSkeleton, Panel, Status, type Tone } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { useCapiEvents, useRetryCapiEvent, type CapiEvent } from "@/features/meta/capi-api";
import { friendlyError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import type { MetaCapiEventName, MetaCapiEventStatus } from "@/types/database";

const STATUS_META: Record<MetaCapiEventStatus, { label: string; tone: Tone }> = {
  sent: { label: "Enviado", tone: "success" },
  pending: { label: "Na fila", tone: "info" },
  failed: { label: "Falhou", tone: "danger" },
  skipped: { label: "Não enviado", tone: "neutral" },
};

const EVENT_LABELS: Record<MetaCapiEventName, string> = {
  Purchase: "Purchase (venda)",
  StartTrial: "StartTrial (teste iniciado)",
  Refund: "Refund (reembolso)",
};

/** Aba "Conversions API" dos Logs de integração. */
export function CapiLogs() {
  const { workspace } = useWorkspace();
  const [status, setStatus] = useState<MetaCapiEventStatus | "all">("all");
  const events = useCapiEvents(workspace.id, status);
  const rows = events.data?.pages.flat() ?? [];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Select value={status} onValueChange={(v) => setStatus(v as MetaCapiEventStatus | "all")}>
          <SelectTrigger className="w-44" aria-label="Status">
            <SelectValue placeholder="Selecione…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {(Object.keys(STATUS_META) as MetaCapiEventStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_META[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {events.isPending ? (
        <PageSkeleton variant="table" />
      ) : events.isError ? (
        <LoadError onRetry={() => events.refetch()} retrying={events.isFetching}>
          Não foi possível carregar os eventos.
        </LoadError>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Send}
          title="Nenhum evento enviado"
          description="Configure a Conversions API em Integrações. Cada venda aprovada aparece aqui."
        />
      ) : (
        <div className="space-y-3">
          <Panel>
            <ul className="divide-y divide-border">
              {rows.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </ul>
          </Panel>
          {events.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                loading={events.isFetchingNextPage}
                loadingText="Carregando…"
                onClick={() => events.fetchNextPage()}
              >
                Carregar mais
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: CapiEvent }) {
  const { workspace } = useWorkspace();
  const retry = useRetryCapiEvent(workspace.id);
  const meta = STATUS_META[event.status];
  const retrying = event.status === "pending" && event.attempts > 0;
  const canRetry = !event.is_test && (event.status === "failed" || retrying);

  return (
    <li>
      <details>
        <summary className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-hover">
          <span className="truncate text-sm font-medium text-foreground">
            {EVENT_LABELS[event.event_name] ?? event.event_name}
            {event.is_test && " · evento de teste"}
          </span>
          <Status tone={retrying ? "warning" : meta.tone}>
            {retrying ? "Tentando de novo" : meta.label}
          </Status>
          <span className="col-span-2 truncate text-xs text-muted-foreground">
            {formatDateTime(event.created_at, workspace.timezone)} · pedido {event.event_id}
            {event.last_error && ` · ${event.last_error}`}
          </span>
        </summary>
        <div className="space-y-3 border-t border-border bg-surface-muted/50 px-4 py-3">
          {event.last_error && <p className="text-sm text-danger-strong">{event.last_error}</p>}
          <p className="text-xs text-muted-foreground">
            Tentativas: {event.attempts}
            {event.sent_at && ` · enviado em ${formatDateTime(event.sent_at, workspace.timezone)}`}
            {retrying &&
              ` · próxima tentativa ${formatDateTime(event.next_attempt_at, workspace.timezone)}`}
            {event.sale_id && (
              <>
                {" · "}
                <Link
                  to={`/w/${workspace.id}/vendas/${event.sale_id}`}
                  className="font-medium text-primary hover:underline"
                >
                  Ver venda
                </Link>
              </>
            )}
          </p>
          {canRetry && (
            <Button
              size="sm"
              variant="outline"
              loading={retry.isPending}
              loadingText="Enviando…"
              onClick={() =>
                retry.mutate(event.id, {
                  onSuccess: () => toast.success("Evento reenviado. Confira o resultado aqui."),
                  onError: (error) => toast.error(friendlyError(error)),
                })
              }
            >
              <RotateCw />
              Tentar de novo
            </Button>
          )}
          {event.request != null && (
            <div className="grid gap-1">
              <p className="text-xs font-medium text-muted-foreground">
                Enviado (e-mail só com hash)
              </p>
              <pre className="max-h-80 overflow-auto rounded-md border border-border bg-surface p-3 text-xs leading-5">
                {JSON.stringify(event.request, null, 2)}
              </pre>
            </div>
          )}
          {event.response != null && (
            <div className="grid gap-1">
              <p className="text-xs font-medium text-muted-foreground">Resposta da Meta</p>
              <pre className="max-h-60 overflow-auto rounded-md border border-border bg-surface p-3 text-xs leading-5">
                {JSON.stringify(event.response, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </details>
    </li>
  );
}
