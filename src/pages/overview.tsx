import { Link } from "react-router";
import { CheckCircle2, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";

const steps = [
  { label: "Workspace criado", done: true },
  { label: "Conectar o checkout (webhook de vendas)", done: false },
  { label: "Ativar notificações de venda no celular", done: false },
  { label: "Conectar a conta de anúncios da Meta", done: false },
  { label: "Configurar UTMs e o script na landing page", done: false },
];

export function OverviewPage() {
  const { workspace, canManage } = useWorkspace();
  return (
    <div className="space-y-6">
      <PageHeader title="Visão geral" subtitle={`Resultados de ${workspace.name}.`} />
      <Panel title="Primeiros passos" description="O dashboard com ROAS, CPA e lucro aparece aqui conforme você conecta as fontes.">
        <ul className="divide-y divide-border">
          {steps.map((step) => (
            <li key={step.label} className="flex items-center gap-3 px-4 py-3 text-sm">
              {step.done ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-label="Concluído" />
              ) : (
                <Circle className="h-5 w-5 shrink-0 text-muted-foreground" aria-label="Pendente" />
              )}
              <span className={step.done ? "text-muted-foreground line-through" : "text-foreground"}>
                {step.label}
              </span>
            </li>
          ))}
        </ul>
        {canManage && (
          <div className="border-t border-border p-4">
            <Button variant="outline" asChild>
              <Link to={`/w/${workspace.id}/ajustes/membros`}>Convidar a equipe</Link>
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}
