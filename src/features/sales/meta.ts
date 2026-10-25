import type { Tone } from "@/components/app/ui";
import type { AttributionStatus, SaleStatus } from "@/types/database";

export const SALE_STATUS_META: Record<SaleStatus, { label: string; tone: Tone }> = {
  approved: { label: "Aprovada", tone: "success" },
  pending: { label: "Pendente", tone: "warning" },
  refunded: { label: "Reembolsada", tone: "neutral" },
  chargeback: { label: "Chargeback", tone: "danger" },
  canceled: { label: "Recusada", tone: "neutral" },
};

export const ATTRIBUTION_META: Record<AttributionStatus, { label: string; tone: Tone; description: string }> = {
  matched: {
    label: "Atribuída",
    tone: "info",
    description: "Campanha, conjunto e criativo identificados.",
  },
  partial: {
    label: "Parcial",
    tone: "warning",
    description: "Chegou com UTMs, mas o criativo ainda não foi encontrado nas suas campanhas sincronizadas.",
  },
  unattributed: {
    label: "Sem origem",
    tone: "neutral",
    description: "Chegou sem UTMs: o link de checkout não levou os parâmetros do anúncio.",
  },
};

export const PROVIDER_LABELS: Record<string, string> = {
  kiwify: "Kiwify",
  hotmart: "Hotmart",
  stripe: "Stripe",
  eduzz: "Eduzz",
  generic: "Genérico",
};
