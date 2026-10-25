import { Navigate, Outlet, useLocation } from "react-router";
import { FullScreenLoader } from "@/components/app/ui";
import { useAuth } from "@/features/auth/auth-provider";

export function RequireAuth() {
  const { user, loading, recovering } = useAuth();
  const location = useLocation();
  if (loading) return <FullScreenLoader />;
  if (recovering) return <Navigate to="/redefinir-senha" replace />;
  if (!user) {
    const next = location.pathname + location.search;
    return <Navigate to={`/entrar?next=${encodeURIComponent(next)}`} replace />;
  }
  return <Outlet />;
}

/** Telas de entrada: quem já está logado vai direto para o app. */
export function RedirectIfAuthenticated() {
  const { user, loading } = useAuth();
  if (loading) return <FullScreenLoader />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Aceita só caminhos internos em ?next= (evita open redirect). */
export function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
