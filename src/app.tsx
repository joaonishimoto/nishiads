import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/app-shell";
import { AuthProvider } from "@/features/auth/auth-provider";
import { RedirectIfAuthenticated, RequireAuth } from "@/features/auth/route-guards";
import { SignInPage } from "@/features/auth/pages/sign-in";
import { ResetPasswordPage } from "@/features/auth/pages/reset-password";
import { WorkspaceBoundary, WorkspaceIndexRedirect } from "@/features/workspaces/workspace-context";
import { CreateWorkspacePage } from "@/features/workspaces/pages/create-workspace";
import { WorkspaceSettingsPage } from "@/features/workspaces/pages/workspace-settings";
import { MembersPage } from "@/features/workspaces/pages/members";
import { AccountPage } from "@/features/account/account-page";
import { NotificationsPage } from "@/features/notifications/pages/notifications-page";
import { SalesPage } from "@/features/sales/pages/sales-page";
import { SaleDetailPage } from "@/features/sales/pages/sale-detail-page";
import { IntegrationsPage } from "@/features/integrations/pages/integrations-page";
import { WebhookLogsPage } from "@/features/integrations/pages/webhook-logs-page";
import { HelpPage } from "@/features/help/help-page";
import { OverviewPage } from "@/pages/overview";
import { CampaignsPage } from "@/features/meta/campaigns-page";
import { AlertsPage } from "@/features/alerts/alerts-page";
import { NotFoundPage } from "@/pages/not-found";
import { ConfigErrorPage } from "@/pages/config-error";
import { env } from "@/lib/env";
import { queryClient } from "@/lib/query-client";

const router = createBrowserRouter([
  {
    element: <RedirectIfAuthenticated />,
    children: [
      { path: "/entrar", element: <SignInPage /> },
    ],
  },
  { path: "/redefinir-senha", element: <ResetPasswordPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: "/", element: <WorkspaceIndexRedirect /> },
      { path: "/workspaces/novo", element: <CreateWorkspacePage /> },
      {
        path: "/w/:workspaceId",
        element: <WorkspaceBoundary />,
        children: [
          {
            element: <AppShell />,
            children: [
              { index: true, element: <OverviewPage /> },
              { path: "vendas", element: <SalesPage /> },
              { path: "vendas/:saleId", element: <SaleDetailPage /> },
              { path: "campanhas", element: <CampaignsPage /> },
              { path: "alertas", element: <AlertsPage /> },
              { path: "integracoes", element: <IntegrationsPage /> },
              { path: "integracoes/logs", element: <WebhookLogsPage /> },
              { path: "ajuda", element: <HelpPage /> },
              { path: "ajustes", element: <WorkspaceSettingsPage /> },
              { path: "ajustes/membros", element: <MembersPage /> },
              { path: "ajustes/notificacoes", element: <NotificationsPage /> },
              { path: "ajustes/conta", element: <AccountPage /> },
              { path: "*", element: <Navigate to="." replace /> },
            ],
          },
        ],
      },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
]);

export function App() {
  if (!env) return <ConfigErrorPage />;
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster position="top-center" />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
