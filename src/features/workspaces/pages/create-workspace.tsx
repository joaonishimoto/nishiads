import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { BrandLogo } from "@/components/app/brand-logo";
import { LoadError } from "@/components/app/ui";
import { useUser } from "@/features/auth/auth-provider";
import { useCreateWorkspace, useMyWorkspaces } from "@/features/workspaces/api";
import { WorkspaceForm } from "@/features/workspaces/workspace-form";
import { friendlyError } from "@/lib/errors";

export function CreateWorkspacePage() {
  const user = useUser();
  const navigate = useNavigate();
  const workspaces = useMyWorkspaces(user.id);
  const create = useCreateWorkspace();
  const isFirst = workspaces.data?.length === 0;

  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 py-10 sm:justify-center">
      <div className="w-full max-w-lg">
        <div className="mb-8 flex justify-center">
          <BrandLogo className="text-[28px]" />
        </div>
        <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-foreground">
            {isFirst ? "Crie seu primeiro workspace" : "Novo workspace"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cada workspace tem suas contas de anúncio, integrações, vendas e equipe. Use um por negócio ou
            cliente.
          </p>
          <div className="mt-6">
            {create.isError && (
              <div className="mb-4">
                <LoadError>{friendlyError(create.error)}</LoadError>
              </div>
            )}
            <WorkspaceForm
              disabled={create.isPending}
              onSubmit={(values) =>
                create.mutate(values, {
                  onSuccess: (workspace) => {
                    toast.success("Workspace criado.");
                    navigate(`/w/${workspace.id}`, { replace: true });
                  },
                })
              }
              footer={
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  {!isFirst && (
                    <Button variant="outline" asChild>
                      <Link to="/">Cancelar</Link>
                    </Button>
                  )}
                  <Button type="submit" loading={create.isPending} loadingText="Criando…">
                    Criar workspace
                  </Button>
                </div>
              }
            />
          </div>
        </div>
      </div>
    </main>
  );
}
