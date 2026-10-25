import { createContext, useContext, useEffect, type ReactNode } from "react";
import { Link, Navigate, Outlet, useParams } from "react-router";
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, FullScreenLoader, LoadError } from "@/components/app/ui";
import { useUser } from "@/features/auth/auth-provider";
import { useMyWorkspaces, type MyWorkspace } from "@/features/workspaces/api";
import { readLocal, writeLocal } from "@/lib/storage";
import type { WorkspaceRole } from "@/types/database";

const LAST_WORKSPACE_KEY = "nishiads:last-workspace";

type WorkspaceContextValue = {
  workspace: MyWorkspace;
  workspaces: MyWorkspace[];
  role: WorkspaceRole;
  /** owner ou admin: pode conectar contas, integrações e gerenciar membros. */
  canManage: boolean;
  isOwner: boolean;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace precisa estar dentro de /w/:workspaceId.");
  return ctx;
}

function CenteredPage({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4">{children}</main>;
}

/** "/" → último workspace usado, o primeiro da lista ou a criação do primeiro. */
export function WorkspaceIndexRedirect() {
  const user = useUser();
  const query = useMyWorkspaces(user.id);

  if (query.isPending) return <FullScreenLoader />;
  if (query.isError) {
    return (
      <CenteredPage>
        <LoadError onRetry={() => query.refetch()} retrying={query.isFetching}>
          Não foi possível carregar seus workspaces.
        </LoadError>
      </CenteredPage>
    );
  }

  const workspaces = query.data;
  if (workspaces.length === 0) return <Navigate to="/workspaces/novo" replace />;
  const last = readLocal(LAST_WORKSPACE_KEY);
  const target = workspaces.find((w) => w.id === last) ?? workspaces[0]!;
  return <Navigate to={`/w/${target.id}`} replace />;
}

/** Resolve o workspace da URL contra os workspaces do usuário (o RLS garante o resto). */
export function WorkspaceBoundary({ children }: { children?: ReactNode }) {
  const { workspaceId } = useParams();
  const user = useUser();
  const query = useMyWorkspaces(user.id);
  const workspace = query.data?.find((w) => w.id === workspaceId);

  useEffect(() => {
    if (workspace) writeLocal(LAST_WORKSPACE_KEY, workspace.id);
  }, [workspace]);

  if (query.isPending) return <FullScreenLoader />;
  if (query.isError) {
    return (
      <CenteredPage>
        <LoadError onRetry={() => query.refetch()} retrying={query.isFetching}>
          Não foi possível carregar o workspace.
        </LoadError>
      </CenteredPage>
    );
  }
  if (!workspace) {
    return (
      <CenteredPage>
        <EmptyState
          icon={Building2}
          title="Workspace não encontrado"
          description="Ele pode ter sido excluído ou você não faz mais parte dele."
          action={
            <Button asChild>
              <Link to="/">Ir para meus workspaces</Link>
            </Button>
          }
        />
      </CenteredPage>
    );
  }

  const value: WorkspaceContextValue = {
    workspace,
    workspaces: query.data,
    role: workspace.role,
    canManage: workspace.role === "owner" || workspace.role === "admin",
    isOwner: workspace.role === "owner",
  };

  return (
    <WorkspaceContext.Provider value={value}>{children ?? <Outlet />}</WorkspaceContext.Provider>
  );
}
