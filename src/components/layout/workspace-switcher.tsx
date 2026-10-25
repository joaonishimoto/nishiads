import { Link, useNavigate } from "react-router";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { ROLE_LABELS } from "@/features/workspaces/schemas";

export function WorkspaceSwitcher({ tone = "sidebar" }: { tone?: "sidebar" | "topbar" }) {
  const { workspace, workspaces } = useWorkspace();
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors",
          tone === "sidebar"
            ? "bg-sidebar-hover/60 text-sidebar-foreground hover:bg-sidebar-hover"
            : "border border-border bg-surface text-foreground hover:bg-surface-hover",
        )}
        aria-label="Trocar de workspace"
      >
        <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => navigate(`/w/${w.id}`)}>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{w.name}</span>
              <span className="block text-xs text-muted-foreground">{ROLE_LABELS[w.role]}</span>
            </span>
            {w.id === workspace.id && <Check className="text-primary" aria-label="Atual" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/workspaces/novo">
            <Plus />
            Novo workspace
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
