import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/features/auth/auth-provider";
import { readLocal, writeLocal } from "@/lib/storage";
import type { Tables, ViewTemplatePage } from "@/types/database";

export type ViewTemplate = Tables<"view_templates">;

const viewKeys = {
  list: (workspaceId: string, userId: string, page: ViewTemplatePage) =>
    ["view-templates", workspaceId, userId, page] as const,
};

/** Templates do usuário logado nesta tela (a RLS já devolve só os dele). */
export function useViewTemplates(workspaceId: string, page: ViewTemplatePage) {
  const user = useUser();
  // Última lista vista neste aparelho: a tela já abre no template certo, sem piscar o padrão.
  const local = `nishiads:views:${workspaceId}:${user.id}:${page}`;
  return useQuery({
    queryKey: viewKeys.list(workspaceId, user.id, page),
    staleTime: 5 * 60_000,
    initialData: () => {
      try {
        const rows = JSON.parse(readLocal(local) ?? "null") as ViewTemplate[] | null;
        return Array.isArray(rows) ? rows : undefined;
      } catch {
        return undefined;
      }
    },
    initialDataUpdatedAt: 0,
    queryFn: async (): Promise<ViewTemplate[]> => {
      const { data, error } = await supabase
        .from("view_templates")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("page", page)
        .order("name");
      if (error) throw error;
      writeLocal(local, JSON.stringify(data ?? []));
      return data ?? [];
    },
  });
}

function useTemplatesCache(workspaceId: string, page: ViewTemplatePage) {
  const user = useUser();
  const qc = useQueryClient();
  const key = viewKeys.list(workspaceId, user.id, page);
  return {
    key,
    qc,
    get: () => qc.getQueryData<ViewTemplate[]>(key),
    set: (rows: ViewTemplate[]) => qc.setQueryData(key, rows),
    invalidate: () => qc.invalidateQueries({ queryKey: key }),
  };
}

export type TemplateValues = { name: string; items: string[] };

/** Cria ou edita um template; salvar já deixa o template escolhido na tela. */
export function useSaveTemplate(workspaceId: string, page: ViewTemplatePage) {
  const cache = useTemplatesCache(workspaceId, page);
  return useMutation({
    mutationFn: async ({ id, values }: { id: string | null; values: TemplateValues }) => {
      const query = id
        ? supabase
            .from("view_templates")
            .update({ ...values, is_default: true })
            .eq("id", id)
        : supabase
            .from("view_templates")
            .insert({ ...values, workspace_id: workspaceId, page, is_default: true });
      const { data, error } = await query.select("*").single();
      if (error) throw error;
      return data;
    },
    onSuccess: (saved) => {
      const rest = (cache.get() ?? []).filter((t) => t.id !== saved.id);
      cache.set(
        [...rest.map((t) => ({ ...t, is_default: false })), saved].sort((a, b) =>
          a.name.localeCompare(b.name, "pt-BR"),
        ),
      );
      void cache.invalidate();
    },
  });
}

/** Troca o template da tela (null = padrão com tudo). Fica salvo para a próxima visita. */
export function useSelectTemplate(workspaceId: string, page: ViewTemplatePage) {
  const cache = useTemplatesCache(workspaceId, page);
  return useMutation({
    mutationFn: async (id: string | null) => {
      const { error } = id
        ? await supabase.from("view_templates").update({ is_default: true }).eq("id", id)
        : await supabase
            .from("view_templates")
            .update({ is_default: false })
            .eq("workspace_id", workspaceId)
            .eq("page", page)
            .eq("is_default", true);
      if (error) throw error;
    },
    onMutate: async (id) => {
      await cache.qc.cancelQueries({ queryKey: cache.key });
      const previous = cache.get();
      if (previous) cache.set(previous.map((t) => ({ ...t, is_default: t.id === id })));
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) cache.set(context.previous);
    },
    onSettled: () => cache.invalidate(),
  });
}

export function useDeleteTemplate(workspaceId: string, page: ViewTemplatePage) {
  const cache = useTemplatesCache(workspaceId, page);
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("view_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_data, id) => {
      cache.set((cache.get() ?? []).filter((t) => t.id !== id));
      void cache.invalidate();
    },
  });
}
