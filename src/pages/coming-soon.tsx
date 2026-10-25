import type { LucideIcon } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/app/ui";

/** Áreas das próximas etapas: navegação já existe, conteúdo chega em seguida. */
export function ComingSoonPage({
  title,
  subtitle,
  icon,
  description,
}: {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  description: string;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} subtitle={subtitle} />
      <EmptyState icon={icon} title="Em construção" description={description} />
    </div>
  );
}
