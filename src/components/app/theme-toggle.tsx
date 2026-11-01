import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { isThemeChoice, useTheme, type ThemeChoice } from "@/lib/theme";

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Claro", icon: Sun },
  { value: "dark", label: "Escuro", icon: Moon },
  { value: "system", label: "Automático", icon: Monitor },
];

/** Botão do topo: alterna entre claro e escuro em um toque. */
export function ThemeToggle() {
  const { theme, setChoice } = useTheme();
  const dark = theme === "dark";
  const label = dark ? "Usar modo claro" : "Usar modo escuro";
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={() => setChoice(dark ? "light" : "dark")}
    >
      {dark ? (
        <Sun className="h-4 w-4" strokeWidth={1.75} />
      ) : (
        <Moon className="h-4 w-4" strokeWidth={1.75} />
      )}
    </Button>
  );
}

/** Escolha completa do tema no menu da conta, incluindo seguir o aparelho. */
export function ThemeMenuOptions() {
  const { choice, setChoice } = useTheme();
  return (
    <>
      <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
        Tema
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={choice}
        onValueChange={(value) => {
          if (isThemeChoice(value)) setChoice(value);
        }}
      >
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuRadioItem
            key={value}
            value={value}
            className="gap-2"
            onSelect={(event) => event.preventDefault()}
          >
            <Icon className="h-4 w-4" strokeWidth={1.75} />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}
