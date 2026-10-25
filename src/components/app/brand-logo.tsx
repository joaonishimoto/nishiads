import { cn } from "@/lib/utils";

/**
 * Identidade Nishiads: mesmas cores da marca Nishistack
 * (Azul Nishi #1E3D66 e Creme Stack #FAF5EB, tokens `brand` e `brand-cream`).
 * Símbolo: três barras crescentes (resultado de anúncio) numa grade de 24 px.
 */
function SymbolShapes() {
  return (
    <g>
      <rect x="0" y="14" width="6" height="10" rx="1.5" />
      <rect x="9" y="7" width="6" height="17" rx="1.5" />
      <rect x="18" y="0" width="6" height="24" rx="1.5" />
    </g>
  );
}

export function BrandSymbol({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("block h-[1em] w-[1em] shrink-0", className)}
      aria-hidden
      fill="currentColor"
    >
      <SymbolShapes />
    </svg>
  );
}

/** Ícone de app: quadrado arredondado azul com o símbolo em creme. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("block h-8 w-8 shrink-0", className)} role="img" aria-label="Nishiads">
      <rect width="32" height="32" rx="7" className="fill-brand" />
      <g className="fill-brand-cream" transform="translate(7 7) scale(0.75)">
        <SymbolShapes />
      </g>
    </svg>
  );
}

/** Logo com nome. O tamanho segue o font-size do className. */
export function BrandLogo({
  tone = "positive",
  className,
}: {
  tone?: "positive" | "negative";
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label="Nishiads"
      className={cn(
        "inline-flex shrink-0 items-center gap-[0.35em] font-brand font-medium",
        tone === "positive" ? "text-brand" : "text-brand-cream",
        className,
      )}
    >
      <BrandSymbol />
      <span aria-hidden className="whitespace-nowrap text-[1.08em] leading-none tracking-[-0.01em]">
        nishiads
      </span>
    </span>
  );
}
