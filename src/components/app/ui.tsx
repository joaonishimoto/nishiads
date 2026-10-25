import type { ReactNode } from "react";
import { RotateCw, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// Peças compartilhadas de página, no mesmo desenho do Nishistack.

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-center sm:justify-between sm:pb-6">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold leading-7 tracking-[-0.015em] text-foreground sm:text-2xl sm:leading-8">
          {title}
        </h1>
        {subtitle && <p className="mt-1 max-w-prose text-sm leading-5 text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-border-strong bg-surface-muted/40 px-6 py-12 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-surface text-primary shadow-xs">
        <Icon className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
      </span>
      <h2 className="mt-4 text-sm font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-sm text-sm leading-5 text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Seção ou página que falhou ao carregar: o que faltou e um jeito de tentar de novo. */
export function LoadError({
  children,
  onRetry,
  retrying = false,
}: {
  children: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-md border border-danger/30 bg-danger/10 p-4 text-sm text-danger-strong sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="min-w-0">{children}</p>
      {onRetry && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0 self-start bg-surface sm:self-auto"
          loading={retrying}
          loadingText="Tentando…"
          onClick={onRetry}
        >
          <RotateCw className="h-4 w-4" />
          Tentar novamente
        </Button>
      )}
    </div>
  );
}

export function Panel({
  title,
  description,
  children,
  className,
  action,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-surface", className)}>
      {title && (
        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";
const tones: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/12 text-success-strong",
  warning: "bg-warning/12 text-warning-strong",
  danger: "bg-danger/12 text-danger-strong",
  info: "bg-info/12 text-info-strong",
  accent: "bg-accent text-accent-foreground",
};

export function Status({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-0.5 text-xs font-medium leading-4 [&_svg]:size-3",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const initials = name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground",
        size === "sm" ? "h-6 w-6 text-[10px]" : "h-9 w-9 text-xs",
      )}
    >
      {initials}
    </span>
  );
}

export function PageSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando">
      <div className="space-y-2 border-b border-border pb-6">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="space-y-3 p-4">
          {Array.from({ length: rows }, (_, row) => (
            <Skeleton key={row} className="h-9 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Tela cheia de carregamento (sessão, troca de workspace). */
export function FullScreenLoader({ label = "Carregando…" }: { label?: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background" aria-busy="true">
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
