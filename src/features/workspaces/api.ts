import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Tables, WorkspaceRole } from "@/types/database";
import type { WorkspaceFormValues } from "@/features/workspaces/schemas";

export type Workspace = Tables<"workspaces">;
export type MyWorkspace = Workspace & { role: WorkspaceRole };

export type Member = {
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  profile: { id: string; email: string; full_name: string | null } | null;
};

export const workspaceKeys = {
  all: ["workspaces"] as const,
  list: (userId: string) => ["workspaces", "list", userId] as const,
  members: (workspaceId: string) => ["workspaces", workspaceId, "members"] as const,
  invitations: (workspaceId: string) => ["workspaces", workspaceId, "invitations"] as const,
};

export function useMyWorkspaces(userId: string) {
  return useQuery({
    queryKey: workspaceKeys.list(userId),
    queryFn: async (): Promise<MyWorkspace[]> => {
      const { data, error } = await supabase
        .from("workspace_members")
        .select("role, workspace:workspaces!inner(id, name, timezone, currency, created_by, created_at, updated_at)")
        .eq("user_id", userId);
      if (error) throw error;
      return (data ?? [])
        .flatMap((row) => (row.workspace ? [{ ...row.workspace, role: row.role }] : []))
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    },
  });
}

export function useMembers(workspaceId: string) {
  return useQuery({
    queryKey: workspaceKeys.members(workspaceId),
    queryFn: async (): Promise<Member[]> => {
      const { data, error } = await supabase
        .from("workspace_members")
        .select("user_id, role, created_at, profile:profiles(id, email, full_name)")
        .eq("workspace_id", workspaceId)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useInvitations(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: workspaceKeys.invitations(workspaceId),
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("workspace_invitations")
        .select("id, email, role, created_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: WorkspaceFormValues) => {
      const { data, error } = await supabase.rpc("create_workspace", {
        p_name: values.name,
        p_timezone: values.timezone,
        p_currency: values.currency,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  });
}

export function useUpdateWorkspace(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: WorkspaceFormValues) => {
      const { error } = await supabase
        .from("workspaces")
        .update({ name: values.name, timezone: values.timezone, currency: values.currency })
        .eq("id", workspaceId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  });
}

export function useDeleteWorkspace(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error, count } = await supabase
        .from("workspaces")
        .delete({ count: "exact" })
        .eq("id", workspaceId);
      if (error) throw error;
      if (count === 0) throw { code: "42501", message: "Só o owner pode excluir o workspace." };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  });
}

export type InviteOutcome = "created" | "added" | "already_member" | "invited";

/** Cria a conta já confirmada (ou adiciona quem já tem conta) pela Edge Function `members`. */
export function useInviteMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: { email: string; role: WorkspaceRole; password: string }) => {
      const { data, error } = await supabase.functions.invoke<{ ok: true; outcome: InviteOutcome }>("members", {
        body: { workspace_id: workspaceId, ...values },
      });
      if (error) {
        const context = (error as { context?: Response }).context;
        const payload = context ? ((await context.json().catch(() => null)) as { error?: string } | null) : null;
        throw new InviteError(payload?.error ?? "function_error");
      }
      return data!.outcome;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspaceKeys.members(workspaceId) });
      qc.invalidateQueries({ queryKey: workspaceKeys.invitations(workspaceId) });
    },
  });
}

export class InviteError extends Error {}

export function inviteErrorMessage(error: unknown): string {
  const code = error instanceof InviteError ? error.message : "";
  if (code === "forbidden") return "Só owners e admins podem convidar.";
  if (code === "owner_only") return "Só um owner pode convidar outro owner.";
  if (code === "unauthorized") return "Sua sessão expirou. Entre novamente.";
  if (code === "weak_password") return "Senha fraca. Use pelo menos 8 caracteres, misturando letras e números.";
  if (code === "invalid_body") return "Confira o e-mail, o papel e a senha.";
  return "Não foi possível convidar agora. Tente de novo.";
}

export function useUpdateMemberRole(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: { userId: string; role: WorkspaceRole }) => {
      const { error } = await supabase.rpc("update_workspace_member_role", {
        p_workspace_id: workspaceId,
        p_user_id: values.userId,
        p_role: values.role,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  });
}

export function useRemoveMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("remove_workspace_member", {
        p_workspace_id: workspaceId,
        p_user_id: userId,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  });
}

export function useRevokeInvitation(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (invitationId: string) => {
      const { error } = await supabase.from("workspace_invitations").delete().eq("id", invitationId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.invitations(workspaceId) }),
  });
}
