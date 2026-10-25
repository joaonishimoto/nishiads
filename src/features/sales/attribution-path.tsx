import { ChevronRight } from "lucide-react";
import { splitUtmRef } from "@/lib/utm";
import type { SaleListItem } from "@/features/sales/api";

type Source = Pick<SaleListItem, "campaign" | "adset" | "ad" | "utm_campaign" | "utm_medium" | "utm_content" | "attribution_status">;

/** Campanha › Conjunto › Criativo. Sem registro sincronizado, mostra o nome que veio no UTM. */
export function originParts(sale: Source): string[] {
  const parts = [
    sale.campaign?.name ?? splitUtmRef(sale.utm_campaign).name ?? splitUtmRef(sale.utm_campaign).id,
    sale.adset?.name ?? splitUtmRef(sale.utm_medium).name ?? splitUtmRef(sale.utm_medium).id,
    sale.ad?.name ?? splitUtmRef(sale.utm_content).name ?? splitUtmRef(sale.utm_content).id,
  ];
  return parts.filter((p): p is string => Boolean(p));
}

export function AttributionPath({ sale, className }: { sale: Source; className?: string }) {
  const parts = originParts(sale);
  if (parts.length === 0) return <span className={className ?? "text-muted-foreground"}>Sem origem</span>;
  return (
    <span className={className ?? "inline-flex min-w-0 flex-wrap items-center gap-x-1 text-foreground"}>
      {parts.map((part, index) => (
        <span key={`${index}-${part}`} className="inline-flex min-w-0 items-center gap-1">
          {index > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="›" />}
          <span className="truncate">{part}</span>
        </span>
      ))}
    </span>
  );
}
