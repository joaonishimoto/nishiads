import { describe, expect, it } from "vitest";
import { controlBlock, optimisticPatch, patchStructure } from "@/features/meta/actions";
import { budgetChange, describeAction, formatBudget, stepBudget } from "@/features/meta/controls";
import { buildTree, type AdStructure } from "@/features/results/metrics";

const structure: AdStructure = {
  campaigns: [
    {
      id: "cbo",
      name: "CBO",
      ad_account_id: "acc",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      daily_budget_cents: 10_000,
      lifetime_budget_cents: null,
    },
    {
      id: "abo",
      name: "ABO",
      ad_account_id: "acc",
      status: "PAUSED",
      effective_status: "PAUSED",
      daily_budget_cents: null,
      lifetime_budget_cents: null,
    },
  ],
  adsets: [
    {
      id: "s1",
      name: "Conjunto CBO",
      ad_account_id: "acc",
      campaign_id: "cbo",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      daily_budget_cents: null,
      lifetime_budget_cents: null,
    },
    {
      id: "s2",
      name: "Conjunto ABO",
      ad_account_id: "acc",
      campaign_id: "abo",
      status: "ACTIVE",
      effective_status: "CAMPAIGN_PAUSED",
      daily_budget_cents: null,
      lifetime_budget_cents: 50_000,
    },
  ],
  ads: [
    {
      id: "a1",
      name: "Anúncio 1",
      ad_account_id: "acc",
      campaign_id: "cbo",
      adset_id: "s1",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      thumbnail_url: null,
      preview_link: null,
    },
    {
      id: "a2",
      name: "Anúncio pausado",
      ad_account_id: "acc",
      campaign_id: "cbo",
      adset_id: "s1",
      status: "PAUSED",
      effective_status: "PAUSED",
      thumbnail_url: null,
      preview_link: null,
    },
  ],
};

const connection = {
  id: "conn",
  status: "active" as const,
  scopes: ["ads_read", "ads_management"],
};
const account = { status: "active" as const, meta_connection_id: "conn" };

describe("controlBlock", () => {
  it("libera owner/admin com ads_management", () => {
    expect(controlBlock(account, [connection], true)).toBeNull();
  });
  it("viewer nunca controla", () => {
    expect(controlBlock(account, [connection], false)).toBe("viewer");
  });
  it("pede a permissão nova ou reconexão", () => {
    expect(controlBlock(account, [{ ...connection, scopes: ["ads_read"] }], true)).toBe(
      "needs_scope",
    );
    expect(controlBlock(account, [{ ...connection, status: "needs_reconnect" }], true)).toBe(
      "needs_reconnect",
    );
    expect(controlBlock({ ...account, meta_connection_id: null }, [connection], true)).toBe(
      "needs_reconnect",
    );
    expect(controlBlock(undefined, [connection], true)).toBe("needs_reconnect");
  });
});

describe("patchStructure", () => {
  it("pausar a campanha marca os filhos ativos como 'campanha pausada'", () => {
    const next = patchStructure(
      structure,
      { level: "campaign", id: "cbo" },
      optimisticPatch({ level: "campaign", id: "cbo", action: "pause" }),
    );
    expect(next.campaigns[0]).toMatchObject({ status: "PAUSED", effective_status: "PAUSED" });
    expect(next.adsets[0]!.effective_status).toBe("CAMPAIGN_PAUSED");
    expect(next.ads[0]!.effective_status).toBe("CAMPAIGN_PAUSED");
    // O anúncio que já estava pausado continua pausado.
    expect(next.ads[1]!.effective_status).toBe("PAUSED");
    // Não muda o original (cache do React Query).
    expect(structure.campaigns[0]!.status).toBe("ACTIVE");
  });

  it("ativar a campanha devolve os filhos ligados para ativo", () => {
    const next = patchStructure(
      structure,
      { level: "campaign", id: "abo" },
      optimisticPatch({ level: "campaign", id: "abo", action: "activate" }),
    );
    expect(next.campaigns[1]!.effective_status).toBe("ACTIVE");
    expect(next.adsets[1]!.effective_status).toBe("ACTIVE");
  });

  it("orçamento troca só o campo informado", () => {
    const next = patchStructure(structure, { level: "adset", id: "s2" }, {}, { lifetime: 60_000 });
    expect(next.adsets[1]).toMatchObject({
      lifetime_budget_cents: 60_000,
      daily_budget_cents: null,
      effective_status: "CAMPAIGN_PAUSED",
    });
  });
});

describe("buildTree com controle", () => {
  const tree = buildTree(structure, [], [], new Map(), "BRL", null, new Set(["abo"]));

  it("leva status configurado, orçamento e CBO para a árvore", () => {
    const cbo = tree.find((c) => c.id === "cbo")!;
    expect(cbo.configuredStatus).toBe("ACTIVE");
    expect(cbo.budget).toEqual({ kind: "daily", cents: 10_000 });
    expect(cbo.children[0]!.usesCampaignBudget).toBe(true);
    expect(cbo.children[0]!.budget).toBeNull();
  });

  it("mantém na tela o que foi alterado pelo app, mesmo pausado e sem gasto", () => {
    const abo = tree.find((c) => c.id === "abo");
    expect(abo).toBeDefined();
    expect(abo!.children).toHaveLength(0);
    expect(buildTree(structure, [], [], new Map(), "BRL", null).some((c) => c.id === "abo")).toBe(
      false,
    );
  });
});

describe("orçamento", () => {
  it("atalhos arredondam para o real e nunca ficam abaixo de R$ 1", () => {
    expect(stepBudget(5_000, 0.2)).toBe(6_000);
    expect(stepBudget(3_333, 0.1)).toBe(3_700);
    expect(stepBudget(100, -0.2)).toBe(100);
  });
  it("calcula a variação", () => {
    expect(budgetChange(5_000, 6_000)).toBeCloseTo(0.2);
    expect(budgetChange(0, 6_000)).toBeNull();
  });
  it("formata diário e total", () => {
    expect(formatBudget({ kind: "daily", cents: 5_000 }, "BRL")).toMatch(/R\$\s?50,00\/dia/);
    expect(formatBudget({ kind: "lifetime", cents: 5_000 }, "BRL")).toMatch(/50,00 total/);
  });
});

describe("histórico", () => {
  it("descreve as ações", () => {
    const base = {
      id: "1",
      object_id: "x",
      ok: true,
      error: null,
      source: "manual" as const,
      created_at: "2026-10-26T03:00:00Z",
      ad_account_id: "acc",
      actor: null,
      previous: null,
      requested: {},
    };
    expect(
      describeAction({ ...base, level: "ad", object_name: "Vídeo 1", action: "pause" }, "BRL"),
    ).toBe("Pausou o anúncio “Vídeo 1”");
    expect(
      describeAction(
        {
          ...base,
          level: "campaign",
          object_name: "Black",
          action: "set_budget",
          previous: { daily_budget_cents: 5_000 },
          requested: { daily_budget_cents: 7_500 },
        },
        "BRL",
      ),
    ).toMatch(/^Mudou o orçamento da campanha “Black” de R\$\s?50,00\/dia para R\$\s?75,00\/dia$/);
  });
});
