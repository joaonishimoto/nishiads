import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { MailPlus, MoreHorizontal, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, EmptyState, LoadError, PageHeader, PageSkeleton, Panel, Status } from "@/components/app/ui";
import { FormField } from "@/components/app/form-field";
import { useUser } from "@/features/auth/auth-provider";
import { SettingsNav } from "@/features/workspaces/pages/settings-nav";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import {
  useInvitations,
  useInviteMember,
  useMembers,
  useRemoveMember,
  useRevokeInvitation,
  useUpdateMemberRole,
  type Member,
} from "@/features/workspaces/api";
import {
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  assignableRoles,
  canManageMember,
  inviteSchema,
  type InviteFormValues,
} from "@/features/workspaces/schemas";
import { friendlyError } from "@/lib/errors";
import { formatDate, plural } from "@/lib/format";
import { validate, type FieldErrors } from "@/lib/form";
import type { WorkspaceRole } from "@/types/database";

const roleTone = { owner: "accent", admin: "info", viewer: "neutral" } as const;

export function MembersPage() {
  const { workspace, canManage } = useWorkspace();
  const members = useMembers(workspace.id);

  return (
    <div className="space-y-6">
      <PageHeader title="Ajustes" subtitle="Dados do workspace, equipe e sua conta." />
      <SettingsNav />

      {canManage && <InviteForm />}

      {members.isPending ? (
        <PageSkeleton variant="settings" />
      ) : members.isError ? (
        <LoadError onRetry={() => members.refetch()} retrying={members.isFetching}>
          Não foi possível carregar os membros.
        </LoadError>
      ) : members.data.length === 0 ? (
        <EmptyState icon={Users} title="Nenhum membro" description="Convide sua equipe pelo e-mail." />
      ) : (
        <Panel title="Membros" description={plural(members.data.length, "pessoa", "pessoas")}>
          <ul className="divide-y divide-border">
            {members.data.map((member) => (
              <MemberRow key={member.user_id} member={member} />
            ))}
          </ul>
        </Panel>
      )}

      {canManage && <PendingInvitations />}
    </div>
  );
}

function InviteForm() {
  const { workspace, role } = useWorkspace();
  const invite = useInviteMember(workspace.id);
  const roles = assignableRoles(role);
  const [values, setValues] = useState<InviteFormValues>({ email: "", role: "viewer" });
  const [errors, setErrors] = useState<FieldErrors<InviteFormValues>>({});

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validate(inviteSchema, values);
    setErrors(result.errors ?? {});
    if (!result.data) return;
    invite.mutate(result.data, {
      onSuccess: (outcome) => {
        const messages = {
          added: "Pessoa adicionada ao workspace.",
          invited: "Convite registrado. A pessoa entra assim que criar a conta com este e-mail.",
          already_member: "Esta pessoa já faz parte do workspace.",
        } as const;
        toast.success(messages[outcome]);
        setValues((v) => ({ ...v, email: "" }));
      },
    });
  }

  return (
    <Panel title="Convidar pessoa" description="Quem já tem conta entra na hora; quem não tem entra ao se cadastrar.">
      <form className="grid gap-4 p-4" onSubmit={onSubmit} noValidate>
        {invite.isError && <LoadError>{friendlyError(invite.error)}</LoadError>}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-start">
          <FormField label="E-mail" error={errors.email}>
            <Input
              type="email"
              inputMode="email"
              autoComplete="off"
              placeholder="pessoa@empresa.com.br"
              value={values.email}
              onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))}
            />
          </FormField>
          <FormField label="Papel" hint={ROLE_DESCRIPTIONS[values.role]}>
            <Select
              value={values.role}
              onValueChange={(next) => setValues((v) => ({ ...v, role: next as WorkspaceRole }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Selecione…" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <Button type="submit" className="sm:mt-6" loading={invite.isPending} loadingText="Convidando…">
            <MailPlus />
            Convidar
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function MemberRow({ member }: { member: Member }) {
  const user = useUser();
  const navigate = useNavigate();
  const { workspace, role } = useWorkspace();
  const updateRole = useUpdateMemberRole(workspace.id);
  const remove = useRemoveMember(workspace.id);
  const [confirm, setConfirm] = useState<"remove" | "leave" | null>(null);

  const isSelf = member.user_id === user.id;
  const name = member.profile?.full_name || member.profile?.email || "Pessoa sem perfil";
  const manageable = canManageMember(role, { role: member.role, isSelf });
  const roles = assignableRoles(role).filter((r) => r !== member.role);

  function changeRole(next: WorkspaceRole) {
    updateRole.mutate(
      { userId: member.user_id, role: next },
      {
        onSuccess: () => toast.success(`${name} agora é ${ROLE_LABELS[next]}.`),
        onError: (error) => toast.error(friendlyError(error)),
      },
    );
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Avatar name={name} showName={false} size="md" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {name}
          {isSelf && <span className="ml-1 font-normal text-muted-foreground">(você)</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {member.profile?.email}
          <span className="hidden sm:inline"> · desde {formatDate(member.created_at, workspace.timezone)}</span>
        </p>
      </div>
      <Status tone={roleTone[member.role]}>{ROLE_LABELS[member.role]}</Status>

      {(manageable || isSelf) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Ações para ${name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {manageable && roles.length > 0 && (
              <>
                <DropdownMenuLabel>Mudar papel</DropdownMenuLabel>
                {roles.map((r) => (
                  <DropdownMenuItem key={r} onSelect={() => changeRole(r)}>
                    Tornar {ROLE_LABELS[r]}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            {manageable && (
              <DropdownMenuItem className="text-danger-strong" onSelect={() => setConfirm("remove")}>
                Remover do workspace
              </DropdownMenuItem>
            )}
            {isSelf && (
              <DropdownMenuItem className="text-danger-strong" onSelect={() => setConfirm("leave")}>
                Sair do workspace
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "leave" ? `Sair de “${workspace.name}”?` : `Remover ${name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "leave"
                ? "Você perde o acesso a este workspace até alguém convidar você de novo."
                : "A pessoa perde o acesso e deixa de receber notificações deste workspace."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {remove.isError && (
            <div className="px-5 py-4 sm:px-6">
              <LoadError>{friendlyError(remove.error)}</LoadError>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-danger-hover"
              loading={remove.isPending}
              loadingText={confirm === "leave" ? "Saindo…" : "Removendo…"}
              onClick={(event) => {
                event.preventDefault();
                remove.mutate(member.user_id, {
                  onSuccess: () => {
                    setConfirm(null);
                    if (confirm === "leave") {
                      toast.success("Você saiu do workspace.");
                      navigate("/", { replace: true });
                    } else {
                      toast.success(`${name} foi removido(a).`);
                    }
                  },
                });
              }}
            >
              {confirm === "leave" ? "Sair do workspace" : "Remover"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function PendingInvitations() {
  const { workspace } = useWorkspace();
  const invitations = useInvitations(workspace.id, true);
  const revoke = useRevokeInvitation(workspace.id);

  if (invitations.isError) {
    return (
      <LoadError onRetry={() => invitations.refetch()} retrying={invitations.isFetching}>
        Não foi possível carregar os convites.
      </LoadError>
    );
  }
  // Sem convites, a seção some: o formulário acima já explica como convidar.
  if (invitations.isPending || invitations.data.length === 0) return null;

  return (
    <Panel title="Convites pendentes" description="Viram membros quando a pessoa confirma o e-mail no cadastro.">
      <ul className="divide-y divide-border">
        {invitations.data.map((inv) => (
          <li key={inv.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{inv.email}</p>
              <p className="text-xs text-muted-foreground">
                Convidado em {formatDate(inv.created_at, workspace.timezone)}
              </p>
            </div>
            <Status tone={roleTone[inv.role]}>{ROLE_LABELS[inv.role]}</Status>
            <Button
              variant="ghost"
              size="sm"
              loading={revoke.isPending && revoke.variables === inv.id}
              loadingText="Revogando…"
              onClick={() =>
                revoke.mutate(inv.id, {
                  onSuccess: () => toast.success("Convite revogado."),
                  onError: (error) => toast.error(friendlyError(error)),
                })
              }
            >
              Revogar
            </Button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
