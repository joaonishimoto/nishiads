import { Link, Navigate } from "react-router";
import { CheckCircle2, ChevronRight, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Panel } from "@/components/app/ui";
import { useSetupSteps } from "@/features/onboarding/setup";
import { useWorkspace } from "@/features/workspaces/workspace-context";

export function OverviewPage() {
  const { workspace, canManage } = useWorkspace();
  const base = `/w/${workspace.id}`;
  const { steps, pending, loaded, complete } = useSetupSteps();

  // Tudo configurado: o checklist não tem mais o que mostrar, o início passa a ser o Dashboard.
  if (complete) return <Navigate to={`${base}/dashboard`} replace />;
  if (!loaded) return null;

  return (
    <div className="space-y-6">
      <PageHeader title="Visão geral" subtitle={`Resultados de ${workspace.name}.`} />
      <Panel
        title="Primeiros passos"
        description={
          pending === 1
            ? "Falta 1 passo. Depois disso o app abre direto no Dashboard."
            : `Faltam ${pending} passos. Lucro, ROAS e CPA aparecem no Dashboard conforme você conecta as fontes.`
        }
      >
        <ul className="divide-y divide-border">
          {steps.map((step) => (
            <li key={step.label}>
              <Link
                to={step.to}
                className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-surface-hover"
              >
                {step.done ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-label="Concluído" />
                ) : (
                  <Circle className="h-5 w-5 shrink-0 text-muted-foreground" aria-label="Pendente" />
                )}
                <span className="min-w-0 flex-1">
                  <span className={step.done ? "text-muted-foreground line-through" : "text-foreground"}>
                    {step.label}
                  </span>
                  {step.hint && <span className="block text-xs text-muted-foreground">{step.hint}</span>}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
        {canManage && (
          <div className="border-t border-border p-4">
            <Button variant="outline" asChild>
              <Link to={`${base}/ajustes/membros`}>Convidar a equipe</Link>
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}
