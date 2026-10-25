import { NavLink, Outlet } from "react-router";
import { ChartNoAxesCombined, LayoutDashboard, Plug, Receipt, Settings, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandLogo, BrandMark } from "@/components/app/brand-logo";
import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";
import { useWorkspace } from "@/features/workspaces/workspace-context";

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

function useNavItems(): NavItem[] {
  const { workspace } = useWorkspace();
  const base = `/w/${workspace.id}`;
  return [
    { to: base, label: "Visão geral", icon: LayoutDashboard, end: true },
    { to: `${base}/vendas`, label: "Vendas", icon: Receipt },
    { to: `${base}/campanhas`, label: "Campanhas", icon: ChartNoAxesCombined },
    { to: `${base}/integracoes`, label: "Integrações", icon: Plug },
    { to: `${base}/ajustes`, label: "Ajustes", icon: Settings },
  ];
}

/** Desktop: barra lateral azul. Celular: topo com workspace e barra de abas embaixo. */
export function AppShell() {
  const items = useNavItems();

  return (
    <div className="min-h-dvh bg-background">
      <aside className="fixed inset-y-0 left-0 z-sidebar hidden w-sidebar flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
        <div className="flex h-topbar items-center px-5">
          <BrandLogo tone="negative" className="text-[23px]" />
        </div>
        <div className="px-3 pb-4">
          <WorkspaceSwitcher />
        </div>
        <nav aria-label="Principal" className="flex flex-1 flex-col gap-1 px-3">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end ?? false}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-foreground",
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" aria-hidden />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <header className="sticky top-0 z-navigation flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur lg:hidden">
        <BrandMark className="h-8 w-8" />
        <div className="min-w-0 flex-1">
          <WorkspaceSwitcher tone="topbar" />
        </div>
      </header>

      <main className="lg:pl-sidebar">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:px-6 lg:px-page-x lg:py-page-y lg:pb-page-y">
          <Outlet />
        </div>
      </main>

      <nav
        aria-label="Principal"
        className="fixed inset-x-0 bottom-0 z-navigation grid grid-cols-5 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end ?? false}
            className={({ isActive }) =>
              cn(
                "flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium transition-colors",
                isActive ? "text-primary" : "text-muted-foreground",
              )
            }
          >
            <item.icon className="h-5 w-5" aria-hidden />
            <span className="truncate">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
