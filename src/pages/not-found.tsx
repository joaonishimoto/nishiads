import { Link } from "react-router";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/ui";

export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4">
      <EmptyState
        icon={Compass}
        title="Página não encontrada"
        description="O endereço pode estar errado ou a página mudou de lugar."
        action={
          <Button asChild>
            <Link to="/">Voltar para o início</Link>
          </Button>
        }
      />
    </main>
  );
}
