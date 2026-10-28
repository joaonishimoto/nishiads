import { describe, expect, it } from "vitest";
import {
  buildMessages,
  checkProposal,
  contextSchema,
  echoContent,
  historyFromRows,
  indexObjects,
} from "./prompt.ts";

const context = contextSchema.parse({
  moeda: "BRL",
  periodo: { rotulo: "Últimos 7 dias" },
  campanhas: [
    {
      id: "c1",
      nome: "Vendas | Frio",
      status: "ACTIVE",
      status_configurado: "ACTIVE",
      orcamento: { tipo: "diario", valor: 100 },
      conjuntos: [
        {
          id: "s1",
          nome: "Interesses",
          status: "ACTIVE",
          status_configurado: "ACTIVE",
          orcamento: null,
          usa_orcamento_da_campanha: true,
          anuncios: [
            { id: "a1", nome: "Vídeo 1", status: "ACTIVE", status_configurado: "ACTIVE" },
            { id: "a2", nome: "Vídeo 2", status: "PAUSED", status_configurado: "PAUSED" },
          ],
        },
      ],
    },
  ],
});
const index = indexObjects(context);

const input = (over: Record<string, unknown>) => ({
  level: "ad",
  id: "a1",
  action: "pause",
  new_budget: null,
  reason: "Gastou R$ 300 sem vender.",
  ...over,
});

describe("checkProposal", () => {
  it("aceita pausar um anúncio ativo que está nos dados", () => {
    const r = checkProposal(input({}), index);
    expect(r).toEqual({
      ok: true,
      proposal: {
        level: "ad",
        id: "a1",
        name: "Vídeo 1",
        action: "pause",
        budget_cents: null,
        budget_kind: null,
        reason: "Gastou R$ 300 sem vender.",
      },
    });
  });

  it("recusa id fora dos dados, nível trocado e ação que não muda nada", () => {
    expect(checkProposal(input({ id: "x" }), index).ok).toBe(false);
    expect(checkProposal(input({ level: "adset" }), index).ok).toBe(false);
    expect(checkProposal(input({ id: "a2" }), index).ok).toBe(false);
    expect(checkProposal(input({ id: "a2", action: "activate" }), index).ok).toBe(true);
  });

  it("orçamento só onde existe orçamento próprio, convertido para centavos", () => {
    const ok = checkProposal(
      input({ level: "campaign", id: "c1", action: "set_budget", new_budget: 125.5 }),
      index,
    );
    expect(ok.ok && ok.proposal).toMatchObject({ budget_cents: 12550, budget_kind: "daily" });
    expect(
      checkProposal(
        input({ level: "adset", id: "s1", action: "set_budget", new_budget: 50 }),
        index,
      ).ok,
    ).toBe(false);
    expect(
      checkProposal(input({ level: "campaign", id: "c1", action: "set_budget" }), index).ok,
    ).toBe(false);
  });
});

describe("historyFromRows", () => {
  const row = (role: "user" | "assistant", content: string, over = {}) => ({
    role,
    content,
    proposals: [],
    status: "done" as const,
    ...over,
  });

  it("pula respostas com erro, junta perguntas seguidas e escreve as sugestões", () => {
    const out = historyFromRows([
      row("user", "a"),
      row("assistant", "", { status: "error" }),
      row("user", "b"),
      row("assistant", "c", {
        proposals: [
          {
            level: "ad",
            id: "a1",
            name: "Vídeo 1",
            action: "pause",
            budget_cents: null,
            budget_kind: null,
            reason: "r",
          },
        ],
      }),
      row("user", "d"),
    ]);
    expect(out).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c\n\n[Sugestões deixadas para confirmar: pausar “Vídeo 1”]" },
      { role: "user", content: "d" },
    ]);
  });

  it("corta o começo sem deixar o assistente em primeiro", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i % 2 ? "assistant" : "user", `m${i}`));
    const out = historyFromRows([...rows, row("user", "fim")], 4);
    expect(out[0]!.role).toBe("user");
    expect(out.at(-1)!.content).toBe("fim");
  });
});

describe("buildMessages", () => {
  it("põe os dados só na primeira pergunta", () => {
    const msgs = buildMessages(
      [
        { role: "user", content: "Como estão as campanhas?" },
        { role: "assistant", content: "Bem." },
        { role: "user", content: "E o anúncio 2?" },
      ],
      '{"moeda":"BRL"}',
    );
    expect(msgs[0]!.content).toEqual([
      { type: "text", text: '<dados_do_app>\n{"moeda":"BRL"}\n</dados_do_app>' },
      { type: "text", text: "Como estão as campanhas?" },
    ]);
    expect(msgs[2]).toEqual({ role: "user", content: "E o anúncio 2?" });
  });
});

describe("echoContent", () => {
  it("antes do último fallback só o texto volta", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text: "parcial" },
      { type: "tool_use", id: "t0", name: "sugerir_alteracao", input: {} },
      { type: "fallback", from: { model: "a" }, to: { model: "b" } },
      { type: "thinking", thinking: "", signature: "s2" },
      { type: "tool_use", id: "t1", name: "sugerir_alteracao", input: {} },
    ] as never;
    expect(echoContent(content).map((b) => b.type)).toEqual(["text", "thinking", "tool_use"]);
  });
});
