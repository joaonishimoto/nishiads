import { useRef, useState, type FormEvent } from "react";
import { RotateCcw, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormField } from "@/components/app/form-field";
import { LoadError, Panel, Status } from "@/components/app/ui";
import { useUser } from "@/features/auth/auth-provider";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import {
  useDailySummaryNumbers,
  useDailySummarySettings,
  useSaveDailySummary,
  useSendDailySummaryTest,
  type DailySummarySettings,
} from "@/features/notifications/daily-summary-api";
import { friendlyError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import type { DailySummaryPeriod } from "@/types/database";
import {
  DEFAULT_BODY,
  DEFAULT_TITLE,
  renderSummary,
  SUMMARY_VARIABLES,
  unknownVariables,
} from "../../../supabase/functions/_shared/daily-summary/template";

const PERIOD_LABEL: Record<DailySummaryPeriod, string> = {
  today: "Hoje, até o horário do envio",
  yesterday: "Ontem, o dia inteiro",
};

function testErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "push_not_configured") {
    return "O envio de push ainda não foi configurado no servidor.";
  }
  return friendlyError(error);
}

/** Resumo do dia por push, no horário e com o texto que a pessoa escolher. */
export function DailySummaryPanel() {
  const { workspace } = useWorkspace();
  const user = useUser();
  const settings = useDailySummarySettings(workspace.id, user.id);

  if (settings.isError) {
    return (
      <LoadError onRetry={() => settings.refetch()} retrying={settings.isFetching}>
        Não foi possível carregar o resumo diário.
      </LoadError>
    );
  }
  if (settings.isPending) return null;
  return <DailySummaryForm key={settings.data?.updated_at ?? "new"} saved={settings.data} />;
}

function DailySummaryForm({ saved }: { saved: DailySummarySettings | null }) {
  const { workspace } = useWorkspace();
  const user = useUser();
  const save = useSaveDailySummary(workspace.id, user.id);
  const test = useSendDailySummaryTest(workspace.id);

  const [enabled, setEnabled] = useState(saved?.enabled ?? false);
  const [time, setTime] = useState(saved?.send_time.slice(0, 5) ?? "21:00");
  const [period, setPeriod] = useState<DailySummaryPeriod>(saved?.period ?? "today");
  const [title, setTitle] = useState(saved?.title_template ?? DEFAULT_TITLE);
  const [body, setBody] = useState(saved?.body_template ?? DEFAULT_BODY);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const numbers = useDailySummaryNumbers(workspace.id, period, enabled);
  const unknown = unknownVariables(`${title}\n${body}`);
  const titleError = !title.trim()
    ? "Escreva um título."
    : title.length > 120
      ? "Até 120 caracteres."
      : undefined;
  const bodyError = !body.trim()
    ? "Escreva a mensagem."
    : body.length > 1000
      ? "Até 1000 caracteres."
      : unknown.length
        ? `Não reconheço ${unknown.join(", ")}. Use os botões abaixo para inserir.`
        : undefined;
  const preview = numbers.data ? renderSummary({ title, body }, numbers.data) : null;

  function toggle(value: boolean) {
    setEnabled(value);
    // Ligar e desligar salva na hora; o texto e o horário salvam no botão.
    if (saved || value) {
      save.mutate(
        saved
          ? { enabled: value }
          : { enabled: value, send_time: time, period, title_template: title, body_template: body },
        {
          onSuccess: () =>
            toast.success(
              value ? `Resumo diário ligado: todo dia às ${time}.` : "Resumo diário desligado.",
            ),
          onError: (e) => {
            setEnabled(!value);
            toast.error(friendlyError(e));
          },
        },
      );
    }
  }

  function insert(key: string) {
    const token = `{${key}}`;
    const el = bodyRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (titleError || bodyError) return;
    save.mutate(
      {
        enabled,
        send_time: time,
        period,
        title_template: title.trim(),
        body_template: body.trim(),
      },
      {
        onSuccess: () => toast.success("Resumo diário salvo."),
        onError: (e) => toast.error(friendlyError(e)),
      },
    );
  }

  return (
    <Panel
      title="Resumo diário"
      description="Um push por dia com cadastros, testes, ROAS e o que mais você quiser."
      action={enabled ? <Status tone="success">Ligado</Status> : <Status>Desligado</Status>}
    >
      <div className="divide-y divide-border">
        <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              Receber o resumo diário
            </span>
            <span className="block text-xs text-muted-foreground">
              {saved?.last_sent_at
                ? `Último envio em ${formatDateTime(saved.last_sent_at, workspace.timezone)}.`
                : "Chega nos dispositivos em que você ativou as notificações."}
            </span>
          </span>
          <Switch checked={enabled} onCheckedChange={toggle} disabled={save.isPending} />
        </label>

        {enabled && (
          <form className="grid gap-4 p-4" onSubmit={onSubmit} noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Horário" hint={`Fuso ${workspace.timezone}.`}>
                <Input
                  type="time"
                  step={300}
                  value={time}
                  onChange={(e) => setTime(e.target.value || "21:00")}
                />
              </FormField>
              <FormField label="Números de">
                <Select value={period} onValueChange={(v) => setPeriod(v as DailySummaryPeriod)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PERIOD_LABEL) as DailySummaryPeriod[]).map((p) => (
                      <SelectItem key={p} value={p}>
                        {PERIOD_LABEL[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            <FormField label="Título" error={titleError}>
              <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </FormField>
            <FormField
              label="Mensagem"
              error={bodyError}
              hint="Escreva do seu jeito. As palavras entre chaves viram os números do dia."
            >
              <Textarea
                ref={bodyRef}
                rows={5}
                value={body}
                maxLength={1000}
                onChange={(e) => setBody(e.target.value)}
              />
            </FormField>

            <div className="grid gap-2">
              <p className="text-xs font-medium text-muted-foreground">Inserir na mensagem</p>
              <div className="flex flex-wrap gap-1.5">
                {SUMMARY_VARIABLES.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => insert(v.key)}
                    className="rounded-full border border-border bg-surface-muted px-2.5 py-1 text-xs text-foreground transition-colors hover:border-primary hover:text-primary"
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Prévia com os números de {period === "today" ? "hoje até agora" : "ontem"}
              </p>
              <div className="rounded-lg border border-border bg-surface-muted p-3">
                {numbers.isError ? (
                  <p className="text-sm text-muted-foreground">
                    Não foi possível carregar os números.
                  </p>
                ) : preview ? (
                  <>
                    <p className="text-sm font-semibold text-foreground">{preview.title}</p>
                    <p className="mt-1 whitespace-pre-line text-sm text-foreground">
                      {preview.body}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Carregando…</p>
                )}
              </div>
            </div>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setTitle(DEFAULT_TITLE);
                  setBody(DEFAULT_BODY);
                }}
              >
                <RotateCcw className="h-4 w-4" />
                Texto padrão
              </Button>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!!titleError || !!bodyError}
                  loading={test.isPending}
                  loadingText="Enviando…"
                  onClick={() =>
                    test.mutate(
                      { period, title_template: title.trim(), body_template: body.trim() },
                      {
                        onSuccess: ({ delivered }) =>
                          delivered > 0
                            ? toast.success("Resumo enviado para seus dispositivos.")
                            : toast.error(
                                "Nenhum dispositivo recebeu. Ative as notificações neste aparelho acima.",
                              ),
                        onError: (e) => toast.error(testErrorMessage(e)),
                      },
                    )
                  }
                >
                  <Send className="h-4 w-4" />
                  Enviar agora
                </Button>
                <Button type="submit" loading={save.isPending} loadingText="Salvando…">
                  Salvar
                </Button>
              </div>
            </div>
          </form>
        )}
      </div>
    </Panel>
  );
}
