import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { readLocal, writeLocal } from "@/lib/storage";
import type { AssistantContext } from "@/features/assistant/context";
import type { AssistantMessageStatus } from "@/types/database";

/** Sugestão que o assistente deixou para o usuário revisar (nada é aplicado sozinho). */
export type Proposal = {
  level: "campaign" | "adset" | "ad";
  id: string;
  name: string;
  action: "pause" | "activate" | "set_budget";
  budget_cents: number | null;
  budget_kind: "daily" | "lifetime" | null;
  reason: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  proposals: Proposal[];
  status: AssistantMessageStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type ConversationSummary = {
  id: string;
  title: string;
  scope: string;
  created_at: string;
  updated_at: string;
};

/** A conversa guarda o recorte do início: as respostas falam sempre dos mesmos números. */
export type Conversation = ConversationSummary & { context: AssistantContext };

/** Sem novidade há mais que isso, a resposta "escrevendo" caiu no meio (a função parou). */
export const STALE_MS = 5 * 60_000;

export function isWriting(m: Pick<ChatMessage, "status" | "updated_at">, now = Date.now()) {
  return m.status === "streaming" && now - new Date(m.updated_at).getTime() < STALE_MS;
}

export const assistantKeys = {
  conversations: (workspaceId: string) => ["assistant", workspaceId, "conversations"] as const,
  conversation: (id: string) => ["assistant", "conversation", id] as const,
  messages: (id: string) => ["assistant", "messages", id] as const,
};

export function useConversations(workspaceId: string) {
  return useQuery({
    queryKey: assistantKeys.conversations(workspaceId),
    queryFn: async (): Promise<ConversationSummary[]> => {
      const { data, error } = await supabase
        .from("assistant_conversations")
        .select("id, title, scope, created_at, updated_at")
        .eq("workspace_id", workspaceId)
        .order("updated_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: assistantKeys.conversation(id ?? ""),
    enabled: !!id,
    staleTime: Infinity,
    queryFn: async (): Promise<Conversation | null> => {
      const { data, error } = await supabase
        .from("assistant_conversations")
        .select("id, title, scope, created_at, updated_at, context")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as Conversation | null) ?? null;
    },
  });
}

/** Mensagens da conversa. Enquanto o assistente escreve, relê a cada segundo. */
export function useMessages(conversationId: string | null) {
  return useQuery({
    queryKey: assistantKeys.messages(conversationId ?? ""),
    enabled: !!conversationId,
    queryFn: async (): Promise<ChatMessage[]> => {
      const { data, error } = await supabase
        .from("assistant_messages")
        .select("id, role, content, proposals, status, error, created_at, updated_at")
        .eq("conversation_id", conversationId!)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as ChatMessage[];
    },
    refetchInterval: (query) => (query.state.data?.some((m) => isWriting(m)) ? 1000 : false),
  });
}

const ERRORS: Record<string, string> = {
  unauthorized: "Sua sessão expirou. Entre novamente.",
  forbidden: "Você não faz parte deste workspace.",
  not_found: "Essa conversa não existe mais. Comece uma nova.",
  invalid_body: "A pergunta está longa demais.",
  invalid_context: "Não foi possível montar os dados do período. Recarregue a página.",
};

export class AssistantError extends Error {}

async function callAssistant<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("assistant", { body });
  if (error) {
    const context = (error as { context?: Response }).context;
    const payload = context
      ? ((await context.json().catch(() => null)) as { error?: string; message?: string } | null)
      : null;
    throw new AssistantError(
      payload?.message ??
        ERRORS[payload?.error ?? ""] ??
        "Não foi possível falar com o assistente agora. Tente de novo.",
    );
  }
  return data!;
}

export type AskInput = {
  question: string;
  conversationId: string | null;
  /** Só para conversa nova: o recorte atual. */
  fresh: { context: AssistantContext; scope: string };
};

/** Envia a pergunta. A resposta é escrita no servidor e chega pelas mensagens. */
export function useAsk(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ question, conversationId, fresh }: AskInput) =>
      callAssistant<{ conversation_id: string; message_id: string }>({
        action: "ask",
        workspace_id: workspaceId,
        question,
        ...(conversationId
          ? { conversation_id: conversationId }
          : { context: fresh.context, scope: fresh.scope }),
      }),
    onSuccess: ({ conversation_id }) => {
      qc.invalidateQueries({ queryKey: assistantKeys.messages(conversation_id) });
      qc.invalidateQueries({ queryKey: assistantKeys.conversations(workspaceId) });
    },
  });
}

export function useStop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId }: { messageId: string; conversationId: string }) =>
      callAssistant<{ ok: true }>({ action: "stop", message_id: messageId }),
    onSettled: (_data, _error, { conversationId }) =>
      qc.invalidateQueries({ queryKey: assistantKeys.messages(conversationId) }),
  });
}

export function useDeleteConversation(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("assistant_conversations").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: assistantKeys.conversations(workspaceId) }),
  });
}

const lastKey = (workspaceId: string) => `nishiads:assistente:atual:${workspaceId}`;

/** Última conversa aberta, para voltar nela ao reabrir a tela. */
export function readLastConversation(workspaceId: string): string | null {
  return readLocal(lastKey(workspaceId));
}

export function writeLastConversation(workspaceId: string, id: string | null): void {
  writeLocal(lastKey(workspaceId), id);
  // Conversas antigas ficavam inteiras no navegador; agora ficam no banco.
  writeLocal(`nishiads:assistente:${workspaceId}`, null);
}
