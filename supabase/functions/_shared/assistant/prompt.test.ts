import { describe, expect, it } from "vitest";
import {
  buildMessages,
  checkProposal,
  contextSchema,
  echoContent,
  historySchema,
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

describe("historySchema", () => {
  it("exige alternância começando e terminando no usuário", () => {
    expect(historySchema.safeParse([{ role: "user", content: "oi" }]).success).toBe(true);
    expect(
      historySchema.safeParse([
        { role: "user", content: "oi" },
        { role: "assistant", content: "olá" },
      ]).success,
    ).toBe(false);
    expect(
      historySchema.safeParse([
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ]).success,
    ).toBe(false);
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
