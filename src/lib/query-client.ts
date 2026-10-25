import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Erros de permissão/validação do banco não melhoram com retry.
        const code = (error as { code?: string } | null)?.code;
        if (code && /^(42|22|23|P0|PGRST)/.test(code)) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: true,
    },
  },
});
