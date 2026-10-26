import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import {
  BookOpen,
  Bell,
  ChartNoAxesCombined,
  ChevronLeft,
  LayoutDashboard,
  LogOut,
  Menu,
  Plug,
  Receipt,
  Settings,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandLogo, BrandMark, BrandSymbol } from "@/components/app/brand-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";
import { useAuth } from "@/features/auth/auth-provider";
import { useWorkspace } from "@/features/workspaces/workspace-context";

// Mesma casca do Nishistack: sidebar azul que recolhe e expande, topo com a conta e,
// no celular, barra de abas com "Mais" abrindo o menu completo.

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };
type NavGroup = { label: string; items: NavItem[] };

function useNav(): { groups: NavGroup[]; footer: NavItem[]; tabs: NavItem[]; base: string } {
  const { workspace } = useWorkspace();
  const base = `/w/${workspace.id}`;
  const overview: NavItem = { to: base, label: "Visão geral", icon: LayoutDashboard, end: true };
  const sales: NavItem = { to: `${base}/vendas`, label: "Vendas", icon: Receipt };
  const campaigns: NavItem = { to: `${base}/campanhas`, label: "Campanhas", icon: ChartNoAxesCombined };
  const integrations: NavItem = { to: `${base}/integracoes`, label: "Integrações", icon: Plug };
  return {
    base,
    groups: [
      { label: "", items: [overview] },
      { label: "Resultados", items: [sales, campaigns] },
      {
        label: "Recursos",
        items: [integrations, { to: `${base}/ajuda`, label: "Documentação", icon: BookOpen }],
      },
    ],
    /** Fica no pé da sidebar, separado das áreas de trabalho. */
    footer: [{ to: `${base}/ajustes`, label: "Ajustes", icon: Settings }],
    tabs: [{ ...overview, label: "Início" }, sales, campaigns, integrations],
  };
}

function SidebarContent({ collapsed }: { collapsed: boolean }) {
  const { groups, footer } = useNav();

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "relative grid h-16 place-items-center border-b border-sidebar-border",
          collapsed ? "px-0" : "px-[22px]",
        )}
      >
        <BrandSymbol
          title="nishiADS"
          className={cn(
            "col-start-1 row-start-1 justify-self-center text-[23px] text-brand-cream transition-opacity duration-[var(--motion-sidebar)] ease-[var(--ease-sidebar)]",
            collapsed ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        />
        <div
          className={cn(
            "col-start-1 row-start-1 flex items-center justify-self-start transition-opacity duration-[var(--motion-sidebar)] ease-[var(--ease-sidebar)]",
            collapsed ? "pointer-events-none w-0 overflow-hidden opacity-0" : "opacity-100",
          )}
        >
          <BrandLogo tone="negative" symbol={false} className="text-[23px]" />
        </div>
      </div>

      <nav aria-label="Navegação principal" className="flex-1 overflow-y-auto px-3 py-4">
        {groups.map((group, index) => (
          <div
            key={group.label || "inicio"}
            className={cn(index > 0 && (collapsed ? "mt-3 border-t border-sidebar-border pt-3" : "mt-6"))}
          >
            {group.label && (
              <p
                className={cn(
                  "px-2.5 text-xs font-medium text-sidebar-muted transition-all duration-[var(--motion-sidebar)] ease-[var(--ease-sidebar)]",
                  collapsed
                    ? "mb-0 h-0 -translate-y-1 overflow-hidden opacity-0"
                    : "mb-1.5 h-4 translate-y-0 opacity-100",
                )}
              >
                {group.label}
              </p>
            )}
            <ul className="space-y-1">
              {group.items.map((item) => (
                <SidebarLink key={item.to} item={item} collapsed={collapsed} />
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-sidebar-border px-3 py-3">
        <ul className="space-y-1">
          {footer.map((item) => (
            <SidebarLink key={item.to} item={item} collapsed={collapsed} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function SidebarLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const Icon = item.icon;
  return (
    <li>
      <NavLink
        to={item.to}
        end={item.end ?? false}
        title={collapsed ? item.label : undefined}
        className={({ isActive }) =>
          cn(
            "relative flex items-center rounded-lg text-[15px] font-medium transition-[background-color,color,gap] duration-[var(--motion-sidebar)] ease-[var(--ease-sidebar)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-indicator",
            collapsed ? "mx-auto h-10 w-10 justify-center gap-0 p-0" : "gap-3 px-2.5 py-2",
            // O hover só realça a linha; a barrinha creme marca a área atual.
            isActive
              ? cn(
                  "bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:inset-y-2 before:w-[3px] before:rounded-r-full before:bg-sidebar-indicator",
                  collapsed ? "before:-left-[18px]" : "before:-left-3",
                )
              : "text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-accent-foreground",
          )
        }
      >
        <Icon className={cn("shrink-0", collapsed ? "h-5 w-5" : "h-[18px] w-[18px]")} strokeWidth={1.75} />
        <span
          className={cn(
            "overflow-hidden whitespace-nowrap text-left transition-[opacity,max-width] duration-[var(--motion-sidebar)] ease-[var(--ease-sidebar)]",
            collapsed ? "max-w-0 opacity-0" : "max-w-44 opacity-100",
          )}
        >
          {item.label}
        </span>
      </NavLink>
    </li>
  );
}

/** Celular: as quatro áreas do dia a dia e "Mais", que abre o menu completo. */
function MobileTabBar({ menuOpen, onMenu }: { menuOpen: boolean; onMenu: () => void }) {
  const { tabs } = useNav();
  const { pathname } = useLocation();
  const tabActive = (tab: NavItem) => (tab.end ? pathname === tab.to : pathname.startsWith(tab.to));
  const anyTab = tabs.some(tabActive);
  const item =
    "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors";
  // Mesma linguagem da sidebar: uma barrinha na borda da área atual.
  const marker =
    "before:absolute before:inset-x-[30%] before:top-0 before:h-[3px] before:rounded-b-full before:bg-primary";
  return (
    <nav
      aria-label="Navegação principal"
      className="fixed inset-x-0 bottom-0 z-navigation border-t border-border-strong bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
    >
      <div className="flex h-16 items-stretch px-1">
        {tabs.map((tab) => {
          const active = tabActive(tab);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={active ? "page" : undefined}
              className={cn(item, active ? cn("text-primary", marker) : "text-muted-foreground")}
            >
              <Icon className="h-5 w-5" strokeWidth={active ? 2 : 1.75} />
              <span className="truncate">{tab.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={onMenu}
          aria-expanded={menuOpen}
          className={cn(item, menuOpen || !anyTab ? cn("text-primary", marker) : "text-muted-foreground")}
        >
          <Menu className="h-5 w-5" strokeWidth={1.75} />
          <span>Mais</span>
        </button>
      </div>
    </nav>
  );
}

function AccountMenu({ base }: { base: string }) {
  const { user, signOut } = useAuth();
  const displayName =
    (user?.user_metadata?.["full_name"] as string | undefined) ?? user?.email?.split("@")[0] ?? "";
  const displayEmail = user?.email ?? "";
  const initials =
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "U";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="Menu da conta"
          title={displayName || displayEmail || "Conta"}
        >
          {initials}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate text-sm font-semibold">{displayName || "Conta"}</span>
          {displayEmail && (
            <span className="truncate text-xs font-normal text-muted-foreground">{displayEmail}</span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="gap-2">
          <Link to={`${base}/ajustes/conta`}>
            <UserRound className="h-4 w-4" strokeWidth={1.75} />
            Minha conta
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="gap-2">
          <Link to={`${base}/ajustes/notificacoes`}>
            <Bell className="h-4 w-4" strokeWidth={1.75} />
            Notificações
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()} className="gap-2 text-danger focus:text-danger">
          <LogOut className="h-4 w-4" strokeWidth={1.75} />
          Sair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell() {
  const { base } = useNav();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar desktop */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-sidebar hidden border-r border-border bg-sidebar transition-[width] duration-[var(--motion-sidebar)] ease-[var(--ease-sidebar)] md:block",
          collapsed ? "w-sidebar-collapsed" : "w-sidebar",
        )}
      >
        <SidebarContent collapsed={collapsed} />
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="absolute -right-3.5 top-[18px] z-sidebar flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface text-muted-foreground shadow-sm transition-[background-color,color,transform] duration-[var(--motion-base)] ease-[var(--ease-sidebar)] hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-90"
          aria-label="Expandir ou recolher menu"
          title="Expandir ou recolher menu"
        >
          <ChevronLeft
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-[var(--motion-sidebar)] ease-[var(--ease-sidebar)]",
              collapsed && "rotate-180",
            )}
            strokeWidth={1.75}
          />
        </button>
      </aside>

      {/* Drawer mobile */}
      {mobileOpen && (
        <div className="fixed inset-0 z-overlay md:hidden">
          <div className="absolute inset-0 bg-overlay" onClick={() => setMobileOpen(false)} />
          <aside
            className="absolute inset-y-0 left-0 w-[min(18rem,85vw)] border-r border-border bg-sidebar pb-[env(safe-area-inset-bottom)]"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("a")) setMobileOpen(false);
            }}
          >
            <SidebarContent collapsed={false} />
          </aside>
        </div>
      )}

      {/* Conteúdo */}
      <div
        className={cn(
          "flex min-h-screen min-w-0 flex-1 flex-col transition-[margin] duration-[var(--motion-sidebar)] ease-[var(--ease-sidebar)]",
          collapsed ? "md:ml-sidebar-collapsed" : "md:ml-sidebar",
        )}
      >
        <header className="sticky top-0 z-navigation flex h-14 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur-md sm:gap-3 md:h-16 md:px-6">
          <button
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Abrir menu"
          >
            <BrandMark />
          </button>

          <div className="min-w-0 max-w-64 flex-1">
            <WorkspaceSwitcher tone="topbar" />
          </div>

          <div className="ml-auto flex items-center gap-3">
            <AccountMenu base={base} />
          </div>
        </header>

        <main className="flex-1 px-4 pt-5 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>
      <MobileTabBar menuOpen={mobileOpen} onMenu={() => setMobileOpen(true)} />
    </div>
  );
}
