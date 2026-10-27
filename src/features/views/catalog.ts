/** Uma métrica, coluna ou seção que o usuário liga ou desliga no template. */
export type ViewOption = { key: string; label: string; group: string; hint?: string };

export type ViewGroup = {
  key: string;
  label: string;
  /** Dá para mudar a ordem dos itens (cartões e colunas); seções têm lugar fixo. */
  reorder: boolean;
};

export type ViewCatalog = {
  groups: ViewGroup[];
  options: ViewOption[];
  /** O que aparece sem template: a tela como sempre foi. */
  defaults: string[];
};

/**
 * Itens a mostrar: os do template, na ordem dele, sem as chaves que não existem mais.
 * Sem template (ou com um template que ficou vazio) vale o padrão.
 */
export function resolveItems(
  items: readonly string[] | null | undefined,
  catalog: ViewCatalog,
): string[] {
  if (!items) return catalog.defaults;
  const known = new Set(catalog.options.map((o) => o.key));
  const seen = new Set<string>();
  const kept = items.filter((k) => known.has(k) && !seen.has(k) && !!seen.add(k));
  return kept.length > 0 ? kept : catalog.defaults;
}

/** Ordem do editor: os escolhidos na ordem do template, depois os demais na ordem do catálogo. */
export function editorOrder(selected: readonly string[], catalog: ViewCatalog): string[] {
  const chosen = new Set(selected);
  return [
    ...selected.filter((k) => catalog.options.some((o) => o.key === k)),
    ...catalog.options.map((o) => o.key).filter((k) => !chosen.has(k)),
  ];
}

/** Move `key` uma posição para cima (-1) ou para baixo (+1) entre os itens do mesmo grupo. */
export function moveWithinGroup(
  order: readonly string[],
  key: string,
  dir: -1 | 1,
  catalog: ViewCatalog,
): string[] {
  const groupOf = (k: string) => catalog.options.find((o) => o.key === k)?.group;
  const group = groupOf(key);
  const same = order.filter((k) => groupOf(k) === group);
  const i = same.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= same.length) return [...order];
  const swapped = [...same];
  [swapped[i], swapped[j]] = [swapped[j]!, swapped[i]!];
  let n = 0;
  return order.map((k) => (groupOf(k) === group ? swapped[n++]! : k));
}

/** Itens a salvar: os marcados, agrupados na ordem dos grupos e, dentro de cada um, na ordem do editor. */
export function itemsToSave(
  order: readonly string[],
  selected: ReadonlySet<string>,
  catalog: ViewCatalog,
): string[] {
  const groupOf = (k: string) => catalog.options.find((o) => o.key === k)?.group;
  return catalog.groups.flatMap((g) =>
    order.filter((k) => groupOf(k) === g.key && selected.has(k)),
  );
}
