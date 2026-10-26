import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowLeft, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CapiLogs } from "@/features/meta/capi-logs";
import {
  EmptyState,
  LoadError,
  PageHeader,
  PageSkeleton,
  Panel,
  Status,
  type Tone,
} from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { useWebhookLogs, type WebhookLog } from "@/features/integrations/api";
import { PROVIDER_LABELS } from "@/features/sales/meta";
import { formatDateTime } from "@/lib/format";
import type { WebhookEventStatus } from "@/types/database";

const STATUS_META: Record<WebhookEventStatus, { label: string; tone: Tone }> = {
  received: { label: "Recebido", tone: "info" },
  processed: { label: "Processado", tone: "success" },
  ignored: { label: "Ignorado", tone: "neutral" },
  rejected: { label: "Recusado", tone: "danger" },
  failed: { label: "Falhou", tone: "danger" },
};

export function WebhookLogsPage() {
  const { workspace, canManage } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const tab = params.get("aba") === "meta" ? "meta" : "webhooks";

  const back = (
    <Link
      to={`/w/${workspace.id}/integracoes`}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-primary"
    >
      <ArrowLeft className="h-4 w-4" />
      Integrações
    </Link>
  );

  if (!canManage) {
    return (
      <div className="space-y-4">
        {back}
        <EmptyState
          icon={ScrollText}
          title="Acesso restrito"
          description="Só owners e admins veem os logs de integração."
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {back}
      <PageHeader
        title="Logs de integração"
        subtitle="Webhooks recebidos dos checkouts e eventos enviados para a Meta. Dados pessoais do comprador não são guardados."
      />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = new URLSearchParams(params);
          if (value === "meta") next.set("aba", "meta");
          else next.delete("aba");
          setParams(next, { replace: true });
        }}
      >
        <TabsList>
          <TabsTrigger value="webhooks">Webhooks dos checkouts</TabsTrigger>
          <TabsTrigger value="meta">Conversions API (Meta)</TabsTrigger>
        </TabsList>
        <TabsContent value="webhooks" className="mt-4">
          <WebhookLogs />
        </TabsContent>
        <TabsContent value="meta" className="mt-4">
          <CapiLogs />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function WebhookLogs() {
  const { workspace } = useWorkspace();
  const [status, setStatus] = useState<WebhookEventStatus | "all">("all");
  const logs = useWebhookLogs(workspace.id, status);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Select value={status} onValueChange={(v) => setStatus(v as WebhookEventStatus | "all")}>
          <SelectTrigger className="w-44" aria-label="Status">
            <SelectValue placeholder="Selecione…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {(Object.keys(STATUS_META) as WebhookEventStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_META[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {logs.isPending ? (
        <PageSkeleton variant="table" />
      ) : logs.isError ? (
        <LoadError onRetry={() => logs.refetch()} retrying={logs.isFetching}>
          Não foi possível carregar os logs.
        </LoadError>
      ) : logs.data.pages.flat().length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="Nenhum webhook recebido"
          description="Use “Testar webhook” no checkout para conferir a configuração."
        />
      ) : (
        <div className="space-y-3">
          <Panel>
            <ul className="divide-y divide-border">
              {logs.data.pages.flat().map((log) => (
                <LogRow key={log.id} log={log} />
              ))}
            </ul>
          </Panel>
          {logs.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                loading={logs.isFetchingNextPage}
                loadingText="Carregando…"
                onClick={() => logs.fetchNextPage()}
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

function LogRow({ log }: { log: WebhookLog }) {
  const { workspace } = useWorkspace();
  const meta = STATUS_META[log.status];
  return (
    <li>
      <details>
        <summary className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-hover">
          <span className="truncate text-sm font-medium text-foreground">
            {log.event_type ?? "Evento"} ·{" "}
            {log.integration?.name ?? PROVIDER_LABELS[log.provider] ?? log.provider}
          </span>
          <Status tone={meta.tone}>{meta.label}</Status>
          <span className="col-span-2 truncate text-xs text-muted-foreground">
            {formatDateTime(log.received_at, workspace.timezone)}
            {log.external_order_id && ` · pedido ${log.external_order_id}`}
            {log.error && ` · ${log.error}`}
          </span>
        </summary>
        <div className="space-y-3 border-t border-border bg-surface-muted/50 px-4 py-3">
          {log.error && <p className="text-sm text-danger-strong">{log.error}</p>}
          <p className="text-xs text-muted-foreground">
            Tentativas de processamento: {log.attempts}
            {log.sale_id && (
              <>
                {" · "}
                <Link
                  to={`/w/${workspace.id}/vendas/${log.sale_id}`}
                  className="font-medium text-primary hover:underline"
                >
                  Ver venda
                </Link>
              </>
            )}
          </p>
          <pre className="max-h-80 overflow-auto rounded-md border border-border bg-surface p-3 text-xs leading-5">
            {JSON.stringify(log.payload, null, 2)}
          </pre>
        </div>
      </details>
    </li>
  );
}
