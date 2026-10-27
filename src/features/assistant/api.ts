import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { env } from "@/lib/env";
import { readLocal, writeLocal } from "@/lib/storage";
import type { AssistantContext } from "@/features/assistant/context";

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
  error?: string;
};

/** A conversa guarda o recorte do início: as respostas falam sempre dos mesmos números. */
export type Conversation = {
  context: AssistantContext;
  /** Período e filtros do recorte, para avisar quando a tela mudou. */
  scope: string;
  messages: ChatMessage[];
};

type StreamEvent =
  | { type: "thinking" }
  | { type: "text"; text: string }
  | { type: "proposal"; proposal: Proposal }
  | { type: "error"; message: string }
  | { type: "done" };

const ERRORS: Record<string, string> = {
  unauthorized: "Sua sessão expirou. Entre novamente.",
  forbidden: "Você não faz parte deste workspace.",
  invalid_body: "A conversa ficou longa demais. Comece uma nova.",
  invalid_context: "Não foi possível montar os dados do período. Recarregue a página.",
};

export class AssistantError extends Error {}

/** Lê a resposta em partes (SSE) e chama `onEvent` a cada evento. */
async function streamAssistant(
  workspaceId: string,
  context: AssistantContext,
  messages: { role: "user" | "assistant"; content: string }[],
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token || !env) throw new AssistantError(ERRORS.unauthorized);
  const response = await fetch(`${env.VITE_SUPABASE_URL}/functions/v1/assistant`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      apikey: env.VITE_SUPABASE_ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workspace_id: workspaceId, context, messages }),
    signal,
  });
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new AssistantError(
      payload?.message ??
        ERRORS[payload?.error ?? ""] ??
        "Não foi possível falar com o assistente agora. Tente de novo.",
    );
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice(6)) as StreamEvent);
    }
  }
}

const storageKey = (workspaceId: string) => `nishiads:assistente:${workspaceId}`;

function loadConversation(workspaceId: string): Conversation | null {
  const raw = readLocal(storageKey(workspaceId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Conversation;
    return Array.isArray(parsed.messages) && parsed.context ? parsed : null;
  } catch {
    return null;
  }
}

const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * Conversa com o assistente, guardada no navegador por workspace. `send` congela o recorte
 * na primeira pergunta; as seguintes reaproveitam o mesmo recorte.
 */
export function useAssistantChat(workspaceId: string) {
  const [conversation, setConversation] = useState<Conversation | null>(() =>
    loadConversation(workspaceId),
  );
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    // Não salva no meio da resposta: só a versão final fica guardada.
    if (streaming) return;
    writeLocal(storageKey(workspaceId), conversation ? JSON.stringify(conversation) : null);
  }, [conversation, streaming, workspaceId]);

  useEffect(() => () => abort.current?.abort(), []);

  const send = useCallback(
    async (text: string, fresh: { context: AssistantContext; scope: string }) => {
      const question = text.trim();
      if (!question || streaming) return;
      const base: Conversation = conversation ?? { ...fresh, messages: [] };
      const user: ChatMessage = { id: newId(), role: "user", content: question, proposals: [] };
      const reply: ChatMessage = { id: newId(), role: "assistant", content: "", proposals: [] };
      const history = [...base.messages.filter((m) => !m.error && m.content), user];
      setConversation({ ...base, messages: [...base.messages, user, reply] });

      const patch = (fn: (m: ChatMessage) => ChatMessage) =>
        setConversation((c) =>
          c ? { ...c, messages: c.messages.map((m) => (m.id === reply.id ? fn(m) : m)) } : c,
        );
      const controller = new AbortController();
      abort.current = controller;
      setStreaming(true);
      setThinking(true);
      try {
        await streamAssistant(
          workspaceId,
          base.context,
          // Respostas com erro ficam fora: a API exige usuário e assistente alternados.
          toApiMessages(history),
          (event) => {
            if (event.type === "thinking") setThinking(true);
            if (event.type === "text") {
              setThinking(false);
              patch((m) => ({ ...m, content: m.content + event.text }));
            }
            if (event.type === "proposal") {
              patch((m) => ({ ...m, proposals: [...m.proposals, event.proposal] }));
            }
            if (event.type === "error") patch((m) => ({ ...m, error: event.message }));
          },
          controller.signal,
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          patch((m) => ({
            ...m,
            error:
              error instanceof AssistantError
                ? error.message
                : "A conexão caiu no meio da resposta. Tente de novo.",
          }));
        }
      } finally {
        setStreaming(false);
        setThinking(false);
        abort.current = null;
        patch((m) =>
          m.content || m.proposals.length || m.error
            ? m
            : { ...m, error: "Resposta interrompida." },
        );
      }
    },
    [conversation, streaming, workspaceId],
  );

  const stop = useCallback(() => abort.current?.abort(), []);
  const reset = useCallback(() => {
    abort.current?.abort();
    setConversation(null);
  }, []);

  return { conversation, streaming, thinking, send, stop, reset };
}

const ACTION_LABEL = { pause: "pausar", activate: "ativar", set_budget: "mudar orçamento de" };

/** Histórico para a API: alternado, curto e com as sugestões já feitas por escrito. */
export function toApiMessages(
  messages: ChatMessage[],
  max = 39,
): { role: "user" | "assistant"; content: string }[] {
  const plain = collapse(
    messages.map((m) => ({
      role: m.role,
      content:
        m.proposals.length > 0
          ? `${m.content}\n\n[Sugestões deixadas para confirmar: ${m.proposals
              .map((p) => `${ACTION_LABEL[p.action]} “${p.name}”`)
              .join("; ")}]`
          : m.content,
    })),
  );
  const recent = plain.slice(-max);
  return recent[0]?.role === "assistant" ? recent.slice(1) : recent;
}

/**
 * Junta perguntas seguidas (sobra de uma resposta que falhou) para manter a alternância
 * usuário/assistente que a API pede.
 */
export function collapse<T extends { role: "user" | "assistant"; content: string }>(
  messages: T[],
): T[] {
  const out: T[] = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (last && last.role === m.role)
      out[out.length - 1] = { ...last, content: `${last.content}\n\n${m.content}` };
    else out.push(m);
  }
  return out;
}
