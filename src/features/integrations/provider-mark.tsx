import { cn } from "@/lib/utils";

export type ProviderMarkKey = "meta" | "kiwify" | "stripe" | "hotmart" | "eduzz" | "generic";

// Cor de marca de cada plataforma, só para reconhecer o card de relance (sem logos de terceiros no bundle).
const MARKS: Record<ProviderMarkKey, { label: string; text: string; className: string }> = {
  meta: { label: "Meta", text: "M", className: "bg-[#0866FF] text-white" },
  kiwify: { label: "Kiwify", text: "K", className: "bg-[#00B37E] text-white" },
  stripe: { label: "Stripe", text: "S", className: "bg-[#635BFF] text-white" },
  hotmart: { label: "Hotmart", text: "H", className: "bg-[#F04E23] text-white" },
  eduzz: { label: "Eduzz", text: "E", className: "bg-[#0D2772] text-white" },
  generic: { label: "Checkout", text: "W", className: "bg-muted text-muted-foreground" },
};

export function ProviderMark({
  provider,
  size = "md",
  className,
}: {
  provider: ProviderMarkKey;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const mark = MARKS[provider] ?? MARKS.generic;
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md font-semibold tracking-tight shadow-xs",
        size === "sm" && "h-7 w-7 text-xs",
        size === "md" && "h-9 w-9 text-sm",
        size === "lg" && "h-11 w-11 text-base",
        mark.className,
        className,
      )}
    >
      {mark.text}
    </span>
  );
}
