import { useId, type ReactElement, cloneElement } from "react";
import { Label } from "@/components/ui/label";

/** Rótulo + controle + erro/ajuda, com aria ligado ao controle. */
export function FormField({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: string;
  children: ReactElement<Record<string, unknown>>;
}) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? hint;
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {cloneElement(children, {
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": message ? messageId : undefined,
      })}
      {message && (
        <p id={messageId} className={error ? "text-xs text-danger-strong" : "text-xs text-muted-foreground"}>
          {message}
        </p>
      )}
    </div>
  );
}
