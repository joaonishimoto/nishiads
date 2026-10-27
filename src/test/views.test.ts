import { describe, expect, it } from "vitest";
import {
  editorOrder,
  itemsToSave,
  moveWithinGroup,
  resolveItems,
  type ViewCatalog,
} from "@/features/views/catalog";

const catalog: ViewCatalog = {
  groups: [
    { key: "cards", label: "Cartões", reorder: true },
    { key: "sections", label: "Seções", reorder: false },
  ],
  options: [
    { key: "revenue", label: "Faturamento", group: "cards" },
    { key: "spend", label: "Gasto", group: "cards" },
    { key: "roas", label: "ROAS", group: "cards" },
    { key: "chart", label: "Gráfico", group: "sections" },
    { key: "sales", label: "Vendas", group: "sections" },
  ],
  defaults: ["revenue", "spend", "chart", "sales"],
};

describe("templates de visualização", () => {
  it("sem template usa o padrão", () => {
    expect(resolveItems(null, catalog)).toEqual(catalog.defaults);
  });

  it("mantém a ordem do template e descarta chaves desconhecidas e repetidas", () => {
    expect(resolveItems(["roas", "sumiu", "revenue", "roas"], catalog)).toEqual([
      "roas",
      "revenue",
    ]);
  });

  it("template que ficou vazio volta para o padrão", () => {
    expect(resolveItems(["sumiu"], catalog)).toEqual(catalog.defaults);
  });

  it("editor lista os escolhidos primeiro e depois o resto", () => {
    expect(editorOrder(["roas", "sales"], catalog)).toEqual([
      "roas",
      "sales",
      "revenue",
      "spend",
      "chart",
    ]);
  });

  it("mover só troca de lugar dentro do grupo", () => {
    const order = ["revenue", "chart", "spend", "sales", "roas"];
    expect(moveWithinGroup(order, "spend", -1, catalog)).toEqual([
      "spend",
      "chart",
      "revenue",
      "sales",
      "roas",
    ]);
    expect(moveWithinGroup(order, "revenue", -1, catalog)).toEqual(order);
    expect(moveWithinGroup(order, "roas", 1, catalog)).toEqual(order);
  });

  it("salva os marcados agrupados na ordem dos grupos", () => {
    const order = ["chart", "roas", "sales", "revenue", "spend"];
    expect(itemsToSave(order, new Set(["chart", "roas", "revenue"]), catalog)).toEqual([
      "roas",
      "revenue",
      "chart",
    ]);
  });
});
