import { Link, useParams } from "react-router";
import { ArrowLeft, ExternalLink, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadError, PageSkeleton, Panel, Status } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { useSale } from "@/features/sales/api";
import { ATTRIBUTION_META, PROVIDER_LABELS, SALE_STATUS_META } from "@/features/sales/meta";
import { formatDateTime, formatMoney } from "@/lib/format";
import { splitUtmRef } from "@/lib/utm";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 px-4 py-2.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children ?? "—"}</dd>
    </div>
  );
}

export function SaleDetailPage() {
  const { saleId = "" } = useParams();
  const { workspace, canManage } = useWorkspace();
  const sale = useSale(workspace.id, saleId);
  const back = (
    <Link
      to={`/w/${workspace.id}/dashboard`}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-primary"
    >
      <ArrowLeft className="h-4 w-4" />
      Dashboard
    </Link>
  );

  if (sale.isPending) return <PageSkeleton variant="detail" />;
  if (sale.isError) {
    return (
      <div className="space-y-4">
        {back}
        <LoadError onRetry={() => sale.refetch()} retrying={sale.isFetching}>
          Não foi possível carregar a venda.
        </LoadError>
      </div>
    );
  }
  if (!sale.data) {
    return (
      <div className="space-y-4">
        {back}
        <EmptyState icon={SearchX} title="Venda não encontrada" description="Ela pode ter sido removida ou o link está errado." />
      </div>
    );
  }

  const s = sale.data;
  const status = SALE_STATUS_META[s.status];
  const isTrial = s.status === "trialing";
  const attribution = ATTRIBUTION_META[s.attribution_status];
  const levels = [
    { label: "Campanha", record: s.campaign, utm: s.utm_campaign },
    { label: "Conjunto", record: s.adset, utm: s.utm_medium },
    { label: "Criativo", record: s.ad, utm: s.utm_content },
  ];

  return (
    <div className="space-y-5">
      {back}
      <header className="flex flex-col gap-3 pb-1 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Status tone={status.tone}>{status.label}</Status>
            <Status tone={attribution.tone}>{attribution.label}</Status>
          </div>
          <h1 className="mt-2 text-2xl font-bold leading-8 tracking-[-0.025em] text-foreground [overflow-wrap:anywhere] sm:text-[32px] sm:leading-10">
            {s.product_name ?? "Produto sem nome"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {PROVIDER_LABELS[s.provider] ?? s.provider} · {isTrial ? "assinatura" : "pedido"} {s.external_order_id}
          </p>
        </div>
        <p className="text-2xl font-semibold tabular-nums text-foreground sm:text-3xl">
          {isTrial ? (s.trial_converted_at ? "Pagou" : "Em teste") : formatMoney(s.gross_amount_cents, s.currency)}
        </p>
      </header>

      <Panel title="Origem" description={attribution.description}>
        <div className="flex gap-4 p-4">
          {s.ad?.thumbnail_url && (
            <img
              src={s.ad.thumbnail_url}
              alt=""
              className="h-20 w-20 shrink-0 rounded-md border border-border object-cover"
              loading="lazy"
            />
          )}
          <ol className="min-w-0 flex-1 space-y-2">
            {levels.map((level) => {
              const fromUtm = splitUtmRef(level.utm);
              const name = level.record?.name ?? fromUtm.name ?? fromUtm.id;
              return (
                <li key={level.label} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 text-sm">
                  <span className="text-muted-foreground">{level.label}</span>
                  <span className="min-w-0 break-words">
                    {name ? (
                      <>
                        <span className="text-foreground">{name}</span>
                        {!level.record && <span className="ml-1 text-xs text-muted-foreground">(do UTM, não sincronizado)</span>}
                      </>
                    ) : (
                      <span className="text-muted-foreground">Não identificado</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
        {s.ad?.preview_link && (
          <div className="border-t border-border px-4 py-3">
            <Button variant="outline" size="sm" asChild>
              <a href={s.ad.preview_link} target="_blank" rel="noreferrer">
                <ExternalLink />
                Ver criativo
              </a>
            </Button>
          </div>
        )}
      </Panel>

      <Panel title="Detalhes">
        {isTrial ? (
          <dl className="divide-y divide-border">
            <Row label="Teste iniciado em">{formatDateTime(s.created_at, workspace.timezone)}</Row>
            <Row label="Primeira cobrança">
              {s.trial_converted_at ? (
                <>
                  {formatDateTime(s.trial_converted_at, workspace.timezone)}
                  {s.converted_sale_id && (
                    <Link
                      to={`/w/${workspace.id}/dashboard/vendas/${s.converted_sale_id}`}
                      className="ml-2 font-medium text-primary underline-offset-4 hover:underline"
                    >
                      Ver venda
                    </Link>
                  )}
                </>
              ) : (
                "Ainda não. O teste vira venda quando a primeira fatura for paga."
              )}
            </Row>
            <Row label="Integração">{s.integration?.name ?? null}</Row>
          </dl>
        ) : (
          <dl className="divide-y divide-border">
            <Row label="Valor bruto">{formatMoney(s.gross_amount_cents, s.currency)}</Row>
            <Row label="Valor líquido">{s.net_amount_cents === null ? null : formatMoney(s.net_amount_cents, s.currency)}</Row>
            <Row label="Pago em">{s.paid_at ? formatDateTime(s.paid_at, workspace.timezone) : null}</Row>
            {s.refunded_at && <Row label="Reembolsado em">{formatDateTime(s.refunded_at, workspace.timezone)}</Row>}
            <Row label="Recebido em">{formatDateTime(s.created_at, workspace.timezone)}</Row>
            <Row label="Integração">{s.integration?.name ?? null}</Row>
          </dl>
        )}
      </Panel>

      <Panel title="UTMs recebidos">
        <dl className="divide-y divide-border font-mono text-xs">
          <Row label="utm_source">{s.utm_source}</Row>
          <Row label="utm_campaign">{s.utm_campaign}</Row>
          <Row label="utm_medium">{s.utm_medium}</Row>
          <Row label="utm_content">{s.utm_content}</Row>
          <Row label="utm_term">{s.utm_term}</Row>
        </dl>
      </Panel>

      {canManage && (
        <details className="rounded-lg border border-border bg-surface">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-foreground">
            Payload recebido (auditoria)
          </summary>
          <pre className="max-h-96 overflow-auto border-t border-border bg-surface-muted p-4 text-xs leading-5">
            {JSON.stringify(s.raw_payload, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
