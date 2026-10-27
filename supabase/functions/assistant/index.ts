/**
 * Assistente de IA das campanhas.
 *
 * POST /functions/v1/assistant   (Authorization: Bearer <access token do usuário>)
 *   { "workspace_id", "context": { ...recorte que o app mostra... },
 *     "messages": [{ "role": "user"|"assistant", "content": "..." }, ...] }
 *   → 200 text/event-stream, uma linha `data: {json}` por evento:
 *       { "type": "thinking" }                     o modelo está analisando
 *       { "type": "text", "text": "..." }          pedaço da resposta
 *       { "type": "proposal", "proposal": {...} }  sugestão para o usuário confirmar
 *       { "type": "error", "message": "..." }      falha no meio da resposta
 *       { "type": "done" }
 *   → 4xx { error: "<código>", message }
 *
 * Qualquer membro do workspace pode perguntar. O assistente nunca muda nada na Meta: as
 * sugestões voltam para o app, que aplica pela meta-actions depois da confirmação.
 * Precisa do secret ANTHROPIC_API_KEY.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  buildMessages,
  checkProposal,
  contextSchema,
  echoContent,
  historySchema,
  indexObjects,
  LIMITS,
  MODEL,
  PROPOSE_TOOL,
  SYSTEM_PROMPT,
  type Proposal,
} from "../_shared/assistant/prompt.ts";
import { errorMessage, log } from "../_shared/log.ts";
import { createAdminClient } from "../_shared/supabase-admin.ts";

/** Perguntas por usuário: proteção contra clique repetido e custo fora do controle. */
const MAX_PER_10_MINUTES = 20;
const MAX_PER_DAY = 200;
/** Voltas do loop de ferramenta (cada sugestão gera uma volta). */
const MAX_TURNS = 4;

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

const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  context: z.unknown(),
  messages: historySchema,
});

type StreamEvent =
  | { type: "thinking" }
  | { type: "text"; text: string }
  | { type: "proposal"; proposal: Proposal }
  | { type: "error"; message: string }
  | { type: "done" };

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

  const context = contextSchema.safeParse(body.context);
  if (!context.success) return json(400, { error: "invalid_context" });
  const contextJson = JSON.stringify(body.context);
  if (contextJson.length > LIMITS.contextChars) {
    return json(413, {
      error: "context_too_large",
      message: "Há campanhas demais no recorte. Filtre por conta ou encurte o período.",
    });
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

  const index = indexObjects(context.data);
  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // O app fechou a conexão: o resto da resposta é descartado.
        }
      };
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: MODEL };
      let proposals = 0;
      let failure: string | null = null;
      const messages = buildMessages(body.messages, contextJson);
      let wroteText = false;

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
            { signal: req.signal },
          );

          let separated = false;
          for await (const event of response) {
            if (event.type === "content_block_start" && event.content_block.type === "thinking") {
              send({ type: "thinking" });
            } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              // Texto de uma nova volta começa num parágrafo novo.
              if (wroteText && !separated) send({ type: "text", text: "\n\n" });
              separated = true;
              wroteText = true;
              send({ type: "text", text: event.delta.text });
            }
          }
          const message = await response.finalMessage();
          usage.model = message.model;
          usage.input += message.usage.input_tokens;
          usage.output += message.usage.output_tokens;
          usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
          usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;

          if (message.stop_reason === "refusal") {
            send({ type: "text", text: `${wroteText ? "\n\n" : ""}${REFUSAL_MESSAGE}` });
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
            proposals++;
            send({ type: "proposal", proposal: check.proposal });
            return {
              type: "tool_result",
              tool_use_id: use.id,
              content:
                "Sugestão mostrada com um botão para a pessoa revisar e confirmar. Ainda não foi aplicada.",
            };
          });
          messages.push({ role: "assistant", content: echoContent(message.content) });
          messages.push({ role: "user", content: results });
        }
      } catch (cause) {
        if (!req.signal.aborted) {
          failure = errorMessage(cause);
          log("error", "assistant_failed", { workspaceId: body.workspace_id, error: failure });
          send({ type: "error", message: friendlyError(cause) });
        } else {
          failure = "aborted";
        }
      }

      const { error: logError } = await admin.from("assistant_usage").insert({
        workspace_id: body.workspace_id,
        user_id: userId,
        model: usage.model,
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_tokens: usage.cacheRead,
        cache_write_tokens: usage.cacheWrite,
        proposals,
        ok: failure === null,
        error: failure,
      });
      if (logError) log("warn", "assistant_usage_insert_failed", { error: logError.message });

      send({ type: "done" });
      try {
        controller.close();
      } catch {
        // Já fechado pelo app.
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
});

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
