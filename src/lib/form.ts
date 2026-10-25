import type { z } from "zod";

export type FieldErrors<T> = Partial<Record<keyof T, string>>;

/** Valida com Zod e devolve os dados ou o primeiro erro de cada campo. */
export function validate<S extends z.ZodTypeAny>(
  schema: S,
  values: unknown,
): { data: z.infer<S>; errors: null } | { data: null; errors: FieldErrors<z.infer<S>> } {
  const result = schema.safeParse(values);
  if (result.success) return { data: result.data, errors: null };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "");
    if (!(key in errors)) errors[key] = issue.message;
  }
  return { data: null, errors: errors as FieldErrors<z.infer<S>> };
}
