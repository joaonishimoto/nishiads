import { NavLink } from "react-router";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/features/workspaces/workspace-context";

export function SettingsNav() {
  const { workspace } = useWorkspace();
  const base = `/w/${workspace.id}/ajustes`;
  const items = [
    { to: base, label: "Workspace", end: true },
    { to: `${base}/membros`, label: "Membros", end: false },
    { to: `${base}/conta`, label: "Minha conta", end: false },
  ];
  return (
    <nav aria-label="Ajustes" className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              "-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
              isActive
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
