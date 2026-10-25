import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Valor somente leitura com botão de copiar (URLs de webhook, parâmetros de UTM). */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Copiado.");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  }

  return (
    <div className="flex min-w-0 items-stretch gap-2">
      <code
        aria-label={label}
        className="min-w-0 flex-1 break-all rounded-md border border-border bg-surface-muted px-3 py-2 font-mono text-xs leading-5 text-foreground select-all"
      >
        {value}
      </code>
      <Button type="button" variant="outline" size="icon" onClick={copy} aria-label={`Copiar ${label}`}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
