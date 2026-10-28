/**
 * Assistente de IA das campanhas.
 *
 * POST /functions/v1/assistant   (Authorization: Bearer <access token do usuário>)
 *   { "action": "ask", "workspace_id", "question",
 *     "conversation_id"?   (continua uma conversa; sem ele, cria uma nova com:)
 *     "context"?, "scope"? (recorte que o app mostra e a chave de período/filtros) }
 *     → 200 { conversation_id, message_id }
 *     A resposta é escrita em segundo plano em assistant_messages (status "streaming" até
 *     terminar); o app lê de lá. Sair da tela não interrompe a resposta.
 *   { "action": "stop", "message_id" }  → 200 { ok: true }   interrompe a resposta
 *   → 4xx { error: "<código>", message }
 *
 * Qualquer membro do workspace pode perguntar; cada um vê só as próprias conversas. O
 * assistente nunca muda nada na Meta: as sugestões ficam na mensagem e o app aplica pela
 * meta-actions depois da confirmação. Precisa do secret ANTHROPIC_API_KEY.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  buildMessages,
  checkProposal,
  contextSchema,
  echoContent,
  historyFromRows,
  indexObjects,
  LIMITS,
  MODEL,
  PROPOSE_TOOL,
  questionSchema,
  SYSTEM_PROMPT,
  type Proposal,
  type StoredMessage,
} from "../_shared/assistant/prompt.ts";
import { errorMessage, log } from "../_shared/log.ts";
import { createAdminClient } from "../_shared/supabase-admin.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

/** Perguntas por usuário: proteção contra clique repetido e custo fora do controle. */
const MAX_PER_10_MINUTES = 20;
const MAX_PER_DAY = 200;
/** Voltas do loop de ferramenta (cada sugestão gera uma volta). */
const MAX_TURNS = 4;
/** De quanto em quanto tempo o texto parcial vai para o banco. */
const FLUSH_MS = 700;
/** Margem para o limite de tempo das tarefas em segundo plano das Edge Functions. */
const DEADLINE_MS = 140_000;
/** Resposta "escrevendo" sem novidade há mais que isso: a função caiu no meio. */
const STALE_MS = 5 * 60_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ask"),
    workspace_id: z.string().uuid(),
    question: questionSchema,
    conversation_id: z.string().uuid().optional(),
    context: z.unknown().optional(),
    scope: z.string().max(300).optional(),
  }),
  z.object({ action: z.literal("stop"), message_id: z.string().uuid() }),
]);

const REFUSAL_MESSAGE =
  "Não consegui responder a essa pergunta. Tente reformular, focando nas métricas das campanhas.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const admin = createAdminClient();

  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: auth, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !auth.user) return json(401, { error: "unauthorized" });
  const userId = auth.user.id;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "invalid_body" });
  const body = parsed.data;

  if (body.action === "stop") {
    const { data: message } = await admin
      .from("assistant_messages")
      .select("id, conversation:assistant_conversations!inner(user_id)")
      .eq("id", body.message_id)
      .maybeSingle();
    const owner = (message?.conversation as unknown as { user_id: string } | null)?.user_id;
    if (!message || owner !== userId) return json(404, { error: "not_found" });
    // A geração confere o status a cada gravação e para sozinha.
    await admin
      .from("assistant_messages")
      .update({ status: "stopped", updated_at: new Date().toISOString() })
      .eq("id", body.message_id)
      .eq("status", "streaming");
    return json(200, { ok: true });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json(503, {
      error: "not_configured",
      message: "O assistente ainda não foi configurado: falta a chave da API da Anthropic.",
    });
  }

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", body.workspace_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!member) return json(403, { error: "forbidden" });

  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  const [recent, today] = await Promise.all([
    admin
      .from("assistant_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", since(10 * 60_000)),
    admin
      .from("assistant_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", since(24 * 60 * 60_000)),
  ]);
  if ((recent.count ?? 0) >= MAX_PER_10_MINUTES) {
    return json(429, {
      error: "too_many_questions",
      message: "Muitas perguntas seguidas. Espere alguns minutos.",
    });
  }
  if ((today.count ?? 0) >= MAX_PER_DAY) {
    return json(429, {
      error: "daily_limit",
      message: "Você chegou ao limite de perguntas de hoje. Volte amanhã.",
    });
  }

  // Conversa: a existente (da própria pessoa) ou uma nova com o recorte atual.
  let conversationId = body.conversation_id;
  let rawContext: unknown;
  if (conversationId) {
    const { data: conversation } = await admin
      .from("assistant_conversations")
      .select("id, context")
      .eq("id", conversationId)
      .eq("workspace_id", body.workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!conversation) return json(404, { error: "not_found" });
    rawContext = conversation.context;
    // Resposta que ficou "escrevendo" porque a função caiu: libera a conversa.
    await admin
      .from("assistant_messages")
      .update({ status: "error", error: "Resposta interrompida." })
      .eq("conversation_id", conversationId)
      .eq("status", "streaming")
      .lt("updated_at", since(STALE_MS));
    const { count: busy } = await admin
      .from("assistant_messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversationId)
      .eq("status", "streaming");
    if ((busy ?? 0) > 0) {
      return json(409, {
        error: "busy",
        message: "O assistente ainda está respondendo a pergunta anterior.",
      });
    }
  } else {
    rawContext = body.context;
  }

  const context = contextSchema.safeParse(rawContext);
  if (!context.success) return json(400, { error: "invalid_context" });
  const contextJson = JSON.stringify(rawContext);
  if (contextJson.length > LIMITS.contextChars) {
    return json(413, {
      error: "context_too_large",
      message: "Há campanhas demais no recorte. Filtre por conta ou encurte o período.",
    });
  }

  if (!conversationId) {
    const { data: created, error } = await admin
      .from("assistant_conversations")
      .insert({
        workspace_id: body.workspace_id,
        user_id: userId,
        title: titleFrom(body.question),
        context: rawContext,
        scope: body.scope ?? "",
      })
      .select("id")
      .single();
    if (error || !created) {
      log("error", "assistant_conversation_insert_failed", { error: error?.message });
      return json(500, { error: "internal_error" });
    }
    conversationId = created.id as string;
  }

  const now = Date.now();
  const { data: inserted, error: insertError } = await admin
    .from("assistant_messages")
    .insert([
      {
        conversation_id: conversationId,
        role: "user",
        content: body.question,
        status: "done",
        created_at: new Date(now).toISOString(),
      },
      {
        conversation_id: conversationId,
        role: "assistant",
        status: "streaming",
        // Um milissegundo depois: a ordem pela data fica sempre pergunta → resposta.
        created_at: new Date(now + 1).toISOString(),
      },
    ])
    .select("id, role");
  const replyId = inserted?.find((m) => m.role === "assistant")?.id as string | undefined;
  if (insertError || !replyId) {
    log("error", "assistant_message_insert_failed", { error: insertError?.message });
    return json(500, { error: "internal_error" });
  }
  await admin
    .from("assistant_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);

  const { data: rows } = await admin
    .from("assistant_messages")
    .select("role, content, proposals, status")
    .eq("conversation_id", conversationId)
    .neq("id", replyId)
    .order("created_at");

  const task = generate(admin, {
    apiKey,
    workspaceId: body.workspace_id,
    userId,
    replyId,
    context: context.data,
    contextJson,
    history: historyFromRows((rows ?? []) as StoredMessage[]),
  });
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(task);
  else await task;

  return json(200, { conversation_id: conversationId, message_id: replyId });
});

function titleFrom(question: string): string {
  const line = question.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/** Escreve a resposta no banco enquanto o modelo gera; para se a pessoa interromper. */
async function generate(
  admin: SupabaseClient,
  input: {
    apiKey: string;
    workspaceId: string;
    userId: string;
    replyId: string;
    context: Parameters<typeof indexObjects>[0];
    contextJson: string;
    history: { role: "user" | "assistant"; content: string }[];
  },
): Promise<void> {
  const index = indexObjects(input.context);
  const client = new Anthropic({ apiKey: input.apiKey });
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort("deadline"), DEADLINE_MS);

  let content = "";
  const proposals: Proposal[] = [];
  let stopped = false;
  let flushedAt = 0;
  let flushing: Promise<void> | null = null;

  /** Grava o parcial. Se a mensagem saiu de "streaming" (a pessoa parou), aborta. */
  const flush = async () => {
    flushedAt = Date.now();
    const { data } = await admin
      .from("assistant_messages")
      .update({ content, proposals, updated_at: new Date().toISOString() })
      .eq("id", input.replyId)
      .eq("status", "streaming")
      .select("id");
    if (!data?.length) {
      stopped = true;
      abort.abort("stopped");
    }
  };
  const maybeFlush = () => {
    if (!flushing && Date.now() - flushedAt >= FLUSH_MS) {
      flushing = flush().finally(() => (flushing = null));
    }
  };

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: MODEL };
  let failure: string | null = null;
  let userError: string | null = null;
  const messages = buildMessages(input.history, input.contextJson);

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 16_000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          cache_control: { type: "ephemeral" },
          system: SYSTEM_PROMPT,
          tools: [PROPOSE_TOOL],
          messages,
        },
        { signal: abort.signal },
      );

      let separated = false;
      for await (const event of response) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          // Texto de uma nova volta começa num parágrafo novo.
          if (content && !separated) content += "\n\n";
          separated = true;
          content += event.delta.text;
          maybeFlush();
        }
      }
      const message = await response.finalMessage();
      usage.model = message.model;
      usage.input += message.usage.input_tokens;
      usage.output += message.usage.output_tokens;
      usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;

      if (message.stop_reason === "refusal") {
        content += `${content ? "\n\n" : ""}${REFUSAL_MESSAGE}`;
        failure = "refusal";
        break;
      }
      const toolUses = message.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );
      // Entrada cortada pelo limite de tokens: não vira sugestão.
      if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((use) => {
        const check = checkProposal(use.input, index);
        if (!check.ok) {
          return { type: "tool_result", tool_use_id: use.id, content: check.error, is_error: true };
        }
        proposals.push(check.proposal);
        return {
          type: "tool_result",
          tool_use_id: use.id,
          content:
            "Sugestão mostrada com um botão para a pessoa revisar e confirmar. Ainda não foi aplicada.",
        };
      });
      maybeFlush();
      messages.push({ role: "assistant", content: echoContent(message.content) });
      messages.push({ role: "user", content: results });
    }
  } catch (cause) {
    if (stopped) {
      failure = "stopped";
    } else if (abort.signal.reason === "deadline") {
      failure = "deadline";
      userError = "A resposta demorou demais e foi cortada. Tente uma pergunta mais específica.";
    } else {
      failure = errorMessage(cause);
      userError = friendlyError(cause);
      log("error", "assistant_failed", { workspaceId: input.workspaceId, error: failure });
    }
  } finally {
    clearTimeout(deadline);
  }

  await flushing;
  if (!stopped) {
    await admin
      .from("assistant_messages")
      .update({
        content,
        proposals,
        status: userError ? "error" : "done",
        error: userError,
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.replyId)
      .eq("status", "streaming");
  } else {
    // Guarda o que já tinha sido escrito, mantendo o status "stopped".
    await admin.from("assistant_messages").update({ content, proposals }).eq("id", input.replyId);
  }

  const { error: logError } = await admin.from("assistant_usage").insert({
    workspace_id: input.workspaceId,
    user_id: input.userId,
    model: usage.model,
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_tokens: usage.cacheRead,
    cache_write_tokens: usage.cacheWrite,
    proposals: proposals.length,
    ok: failure === null,
    error: failure,
  });
  if (logError) log("warn", "assistant_usage_insert_failed", { error: logError.message });
}

function friendlyError(cause: unknown): string {
  if (cause instanceof Anthropic.AuthenticationError) {
    return "A chave da API da Anthropic é inválida. Confira o secret ANTHROPIC_API_KEY.";
  }
  if (cause instanceof Anthropic.RateLimitError) {
    return "O assistente está com muitas perguntas agora. Tente de novo em um minuto.";
  }
  if (cause instanceof Anthropic.APIError && cause.status === 529) {
    return "O assistente está sobrecarregado agora. Tente de novo em instantes.";
  }
  return "Não foi possível terminar a resposta. Tente de novo.";
}
