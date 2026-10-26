import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { AlertTriangle, LogIn, Megaphone, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { LoadError, Panel, Status, type Tone } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import {
  isSyncing,
  metaErrorMessage,
  oauthReturnMessage,
  useAdAccounts,
  useConnectMeta,
  useDisconnectMeta,
  useMetaConnections,
  useSetTracked,
  useSyncNow,
  type AdAccount,
  type MetaConnection,
} from "@/features/meta/api";
import { friendlyError } from "@/lib/errors";
import { formatDate, formatDateTime, plural } from "@/lib/format";

/** Avisa a partir de 7 dias antes de o token de longa duração (~60 dias) expirar. */
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60_000;

/** Lê ?meta=conectado / ?meta_erro=... deixados pela volta do Facebook e limpa a URL. */
function useOAuthReturnToast() {
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const ok = params.get("meta");
    const error = params.get("meta_erro");
    if (!ok && !error) return;
    if (ok === "conectado") {
      const count = Number(params.get("contas") ?? 0);
      toast.success(
        count > 0
          ? `Meta conectada. ${plural(count, "conta encontrada", "contas encontradas")}: escolha quais acompanhar.`
          : "Meta conectada, mas nenhuma conta de anúncio foi encontrada para este login.",
      );
    } else if (error) {
      toast.error(oauthReturnMessage(error));
    }
    const next = new URLSearchParams(params);
    ["meta", "meta_erro", "contas"].forEach((k) => next.delete(k));
    setParams(next, { replace: true });
  }, [params, setParams]);
}

export function MetaAdsPanel() {
  const { workspace, canManage } = useWorkspace();
  const connections = useMetaConnections(workspace.id);
  const accounts = useAdAccounts(workspace.id);
  const connect = useConnectMeta(workspace.id);
  const syncNow = useSyncNow(workspace.id);
  useOAuthReturnToast();

  const startConnect = () => connect.mutate(undefined, { onError: (error) => toast.error(metaErrorMessage(error)) });
  const tracked = accounts.data?.filter((a) => a.is_tracked) ?? [];
  const anySyncing = tracked.some(isSyncing);

  if (connections.isPending || accounts.isPending) {
    return (
      <Panel title="Meta Ads">
        <div className="space-y-3 p-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </Panel>
    );
  }
  if (connections.isError || accounts.isError) {
    return (
      <LoadError
        onRetry={() => {
          connections.refetch();
          accounts.refetch();
        }}
        retrying={connections.isFetching || accounts.isFetching}
      >
        Não foi possível carregar a conexão com a Meta.
      </LoadError>
    );
  }

  if (connections.data.length === 0 && accounts.data.length === 0) {
    return (
      <Panel title="Meta Ads" description="Gasto, impressões e criativos de cada anúncio, para calcular ROAS e CPA.">
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {canManage
              ? "Entre com o Facebook que administra suas contas de anúncio. O Nishiads só lê os dados (ads_read)."
              : "Peça a um owner ou admin para conectar a Meta Ads."}
          </p>
          {canManage && (
            <Button className="shrink-0" onClick={startConnect} loading={connect.isPending} loadingText="Abrindo…">
              <LogIn />
              Conectar Meta Ads
            </Button>
          )}
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Meta Ads"
      description="Sincroniza a cada 15 minutos. Os últimos 3 dias são refeitos, porque a Meta ajusta os números depois."
      action={
        tracked.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            loading={syncNow.isPending || anySyncing}
            loadingText="Sincronizando…"
            onClick={() =>
              syncNow.mutate(undefined, {
                onSuccess: ({ started }) =>
                  started === 0 ? toast.info("As contas acabaram de sincronizar. Tente de novo em 1 minuto.") : undefined,
                onError: (error) => toast.error(metaErrorMessage(error)),
              })
            }
          >
            <RefreshCw />
            Sincronizar agora
          </Button>
        )
      }
    >
      <div className="divide-y divide-border">
        {connections.data.map((connection) => (
          <ConnectionRow key={connection.id} connection={connection} onReconnect={startConnect} reconnecting={connect.isPending} />
        ))}
        {connections.data.length === 0 && (
          <div className="flex flex-col gap-3 bg-warning/10 p-4 text-sm text-warning-strong sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>A conexão com a Meta foi removida. Conecte de novo para voltar a sincronizar.</p>
            </div>
            {canManage && (
              <Button size="sm" className="shrink-0 self-start sm:self-auto" onClick={startConnect} loading={connect.isPending}>
                <LogIn />
                Conectar
              </Button>
            )}
          </div>
        )}

        {accounts.data.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            Nenhuma conta de anúncio encontrada para este login. Confira se o seu usuário tem acesso às contas no
            Gerenciador de Negócios e conecte de novo.
          </p>
        ) : (
          <div>
            <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
              <p className="text-sm font-medium text-foreground">Contas de anúncio</p>
              <p className="text-xs text-muted-foreground">
                {plural(tracked.length, "acompanhada", "acompanhadas")} de {accounts.data.length}
              </p>
            </div>
            <ul className="divide-y divide-border">
              {accounts.data.map((account) => (
                <AccountRow key={account.id} account={account} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}

function ConnectionRow({
  connection,
  onReconnect,
  reconnecting,
}: {
  connection: MetaConnection;
  onReconnect: () => void;
  reconnecting: boolean;
}) {
  const { workspace, canManage } = useWorkspace();
  const disconnect = useDisconnectMeta(workspace.id);
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : null;
  const expiringSoon = expiresAt !== null && expiresAt - Date.now() < EXPIRY_WARNING_MS;
  const needsReconnect = connection.status === "needs_reconnect" || (expiresAt !== null && expiresAt < Date.now());
  const who = connection.meta_user_name ?? "Facebook";

  return (
    <div>
      {(needsReconnect || expiringSoon) && (
        <div
          className={
            needsReconnect
              ? "flex flex-col gap-3 bg-danger/10 p-4 text-sm text-danger-strong sm:flex-row sm:items-center sm:justify-between"
              : "flex flex-col gap-3 bg-warning/10 p-4 text-sm text-warning-strong sm:flex-row sm:items-center sm:justify-between"
          }
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>
              {needsReconnect
                ? `O acesso de ${who} à Meta expirou ou foi revogado. Reconecte para voltar a sincronizar.`
                : `O acesso de ${who} expira em ${formatDate(connection.token_expires_at!, workspace.timezone)}. Reconecte antes para não parar a sincronização.`}
            </p>
          </div>
          {canManage && (
            <Button size="sm" className="shrink-0 self-start sm:self-auto" onClick={onReconnect} loading={reconnecting}>
              <LogIn />
              Reconectar
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Conectado como {who}</p>
          <p className="text-xs text-muted-foreground">
            {connection.token_expires_at
              ? `Acesso válido até ${formatDate(connection.token_expires_at, workspace.timezone)}`
              : "Acesso sem data de expiração"}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {!needsReconnect && (
              <Button variant="outline" size="sm" onClick={onReconnect} loading={reconnecting}>
                <LogIn />
                Reconectar
              </Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="text-danger-strong">
                  <Unplug />
                  Desconectar
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Desconectar a Meta?</AlertDialogTitle>
                  <AlertDialogDescription>
                    O token de acesso é apagado e a sincronização para. Campanhas, criativos e gastos já sincronizados
                    continuam no Nishiads.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-danger-hover"
                    loading={disconnect.isPending}
                    loadingText="Desconectando…"
                    onClick={(event) => {
                      event.preventDefault();
                      disconnect.mutate(connection.id, {
                        onSuccess: () => toast.success("Meta desconectada."),
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
    </div>
  );
}

function accountState(account: AdAccount): { tone: Tone; label: string } {
  if (!account.is_tracked) return { tone: "neutral", label: "Não acompanhada" };
  if (account.status === "needs_reconnect") return { tone: "danger", label: "Reconectar" };
  if (account.status === "disabled") return { tone: "neutral", label: "Desativada na Meta" };
  if (isSyncing(account)) return { tone: "info", label: account.backfilled_at ? "Sincronizando" : "Importando 30 dias" };
  if (account.status === "error" || account.last_sync_error) return { tone: "warning", label: "Com erro" };
  if (!account.last_synced_at) return { tone: "info", label: "Aguardando" };
  return { tone: "success", label: "Sincronizada" };
}

function AccountRow({ account }: { account: AdAccount }) {
  const { workspace, canManage } = useWorkspace();
  const setTracked = useSetTracked(workspace.id);
  const state = accountState(account);

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{account.name}</p>
          <p className="text-xs text-muted-foreground">
            act_{account.external_id} · {account.currency}
            {account.is_tracked && account.last_synced_at
              ? ` · sincronizada em ${formatDateTime(account.last_synced_at, workspace.timezone)}`
              : ""}
          </p>
          {account.is_tracked && account.last_sync_error && !isSyncing(account) && (
            <p className="mt-1 text-xs text-warning-strong">{account.last_sync_error}</p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3 pl-7 sm:pl-0">
        <Status tone={state.tone}>{state.label}</Status>
        {canManage && (
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              checked={account.is_tracked}
              disabled={setTracked.isPending || account.status === "needs_reconnect"}
              aria-label={`Acompanhar ${account.name}`}
              onCheckedChange={(tracked) =>
                setTracked.mutate(
                  { id: account.id, tracked },
                  {
                    onSuccess: () =>
                      toast.success(
                        tracked
                          ? `Acompanhando ${account.name}. Importando os últimos 30 dias.`
                          : `${account.name} não será mais sincronizada.`,
                      ),
                    onError: (error) => toast.error(friendlyError(error)),
                  },
                )
              }
            />
            <span className="sm:hidden">Acompanhar</span>
          </label>
        )}
      </div>
    </li>
  );
}
