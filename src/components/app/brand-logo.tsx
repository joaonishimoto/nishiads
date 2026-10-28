import { cn } from "@/lib/utils";

/**
 * Identidade Nishistack - ADS: mesmas cores da marca Nishistack
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

/** Símbolo solto (sem quadrado), na cor do texto atual. Mede 1em. */
export function BrandSymbol({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("block h-[1em] w-[1em] shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      fill="currentColor"
    >
      <SymbolShapes />
    </svg>
  );
}

/** Ícone de app: quadrado arredondado azul com o símbolo em creme. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("block h-8 w-8 shrink-0", className)} role="img" aria-label="Nishistack - ADS">
      <rect width="32" height="32" rx="7" className="fill-brand" />
      <g className="fill-brand-cream" transform="translate(7 7) scale(0.75)">
        <SymbolShapes />
      </g>
    </svg>
  );
}

/**
 * Logo com nome. O tamanho segue o font-size do className.
 * `symbol={false}` mostra só o nome (sidebar aberta; o símbolo aparece só recolhida), como no Nishistack.
 */
export function BrandLogo({
  tone = "positive",
  symbol = true,
  name = "Nishistack - ADS",
  className,
}: {
  tone?: "positive" | "negative";
  symbol?: boolean;
  /** Nome escrito ao lado do símbolo. */
  name?: string;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        "inline-flex shrink-0 items-center gap-[0.35em] font-brand font-medium",
        tone === "positive" ? "text-brand" : "text-brand-cream",
        className,
      )}
    >
      {symbol && <BrandSymbol />}
      <span aria-hidden className="whitespace-nowrap text-[1.08em] leading-none tracking-[-0.01em]">
        {name}
      </span>
    </span>
  );
}
