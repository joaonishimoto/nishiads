export type SortScalar = string | number | boolean | null | undefined;
/** A column's sort key; a tuple sorts by its first item, then the next (e.g. currency, then amount). */
export type SortKey = SortScalar | readonly SortScalar[];
export type SortDirection = "asc" | "desc";
export interface SortState {
  column: string;
  direction: SortDirection;
}

const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });

const isEmpty = (value: SortScalar) => value === null || value === undefined || value === "";

function compareScalar(a: SortScalar, b: SortScalar): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

function compareKeys(a: SortKey, b: SortKey): number {
  const left = Array.isArray(a) ? a : [a as SortScalar];
  const right = Array.isArray(b) ? b : [b as SortScalar];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const result = compareScalar(left[index], right[index]);
    if (result !== 0) return result;
  }
  return 0;
}

/** Sorts a copy of the rows; empty values stay at the end in both directions and ties keep their original order. */
export function sortRows<T>(
  rows: readonly T[],
  key: (row: T) => SortKey,
  direction: SortDirection,
): T[] {
  const sign = direction === "asc" ? 1 : -1;
  const keyed = rows.map((row) => ({ row, key: key(row) }));
  keyed.sort((a, b) => {
    const emptyA = !Array.isArray(a.key) && isEmpty(a.key as SortScalar);
    const emptyB = !Array.isArray(b.key) && isEmpty(b.key as SortScalar);
    if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
    return sign * compareKeys(a.key, b.key);
  });
  return keyed.map((item) => item.row);
}

/** Header clicks cycle: ascending → descending → original order. */
export function nextSort(current: SortState | null, column: string): SortState | null {
  if (current?.column !== column) return { column, direction: "asc" };
  return current.direction === "asc" ? { column, direction: "desc" } : null;
}
