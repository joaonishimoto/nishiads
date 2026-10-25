import { envErrors } from "@/lib/env";

/** Mostrada quando faltam variáveis de ambiente no build (ex.: Vercel sem VITE_SUPABASE_*). */
export function ConfigErrorPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-3 px-4">
      <h1 className="text-lg font-semibold text-foreground">Configuração incompleta</h1>
      <p className="text-sm text-muted-foreground">
        Defina as variáveis de ambiente do frontend (veja <code>.env.example</code>) e gere o build de novo.
      </p>
      <ul className="list-disc pl-5 text-sm text-danger-strong">
        {envErrors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </main>
  );
}
