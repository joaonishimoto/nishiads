import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { LoadError, PageHeader, Panel } from "@/components/app/ui";
import { FormField } from "@/components/app/form-field";
import { SettingsNav } from "@/features/workspaces/pages/settings-nav";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { useDeleteWorkspace, useUpdateWorkspace } from "@/features/workspaces/api";
import { WorkspaceForm } from "@/features/workspaces/workspace-form";
import type { WorkspaceFormValues } from "@/features/workspaces/schemas";
import { friendlyError } from "@/lib/errors";

export function WorkspaceSettingsPage() {
  const { workspace, canManage, isOwner } = useWorkspace();
  const update = useUpdateWorkspace(workspace.id);

  return (
    <div className="space-y-6">
      <PageHeader title="Ajustes" subtitle="Dados do workspace, equipe e sua conta." />
      <SettingsNav />

      <Panel
        title="Workspace"
        description={canManage ? undefined : "Só owners e admins podem alterar estes dados."}
      >
        <div className="p-4">
          {update.isError && (
            <div className="mb-4">
              <LoadError>{friendlyError(update.error)}</LoadError>
            </div>
          )}
          <WorkspaceForm
            key={workspace.updated_at}
            initialValues={{
              name: workspace.name,
              timezone: workspace.timezone as WorkspaceFormValues["timezone"],
              currency: workspace.currency as WorkspaceFormValues["currency"],
            }}
            disabled={!canManage || update.isPending}
            onSubmit={(values) =>
              update.mutate(values, { onSuccess: () => toast.success("Workspace atualizado.") })
            }
            footer={
              canManage && (
                <div className="flex justify-end">
                  <Button type="submit" loading={update.isPending} loadingText="Salvando…">
                    Salvar alterações
                  </Button>
                </div>
              )
            }
          />
        </div>
      </Panel>

      {isOwner && <DangerZone />}
    </div>
  );
}

function DangerZone() {
  const { workspace } = useWorkspace();
  const navigate = useNavigate();
  const remove = useDeleteWorkspace(workspace.id);
  const [confirmation, setConfirmation] = useState("");
  const matches = confirmation.trim() === workspace.name;

  return (
    <Panel title="Excluir workspace" className="border-danger/30">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Apaga para sempre contas conectadas, integrações, vendas e o histórico deste workspace.
        </p>
        <AlertDialog onOpenChange={() => setConfirmation("")}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" className="shrink-0">
              Excluir workspace
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Excluir “{workspace.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                Esta ação não pode ser desfeita. Digite o nome do workspace para confirmar.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="px-5 py-4 sm:px-6">
              <FormField label="Nome do workspace">
                <Input
                  placeholder={workspace.name}
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </FormField>
              {remove.isError && (
                <div className="mt-3">
                  <LoadError>{friendlyError(remove.error)}</LoadError>
                </div>
              )}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-danger-hover"
                disabled={!matches}
                loading={remove.isPending}
                loadingText="Excluindo…"
                onClick={(event) => {
                  event.preventDefault();
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      toast.success("Workspace excluído.");
                      navigate("/", { replace: true });
                    },
                  });
                }}
              >
                Excluir workspace
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Panel>
  );
}
