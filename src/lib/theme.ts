import { useSyncExternalStore } from "react";

/**
 * Tema da interface: claro, escuro ou automático (segue o aparelho).
 * A escolha fica salva no aparelho (localStorage) e vale para todas as telas.
 */
export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "nishiads-tema";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const THEME_COLORS: Record<ResolvedTheme, string> = { light: "#1e3d66", dark: "#111418" };

const listeners = new Set<() => void>();

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : "light";
  } catch {
    return "light";
  }
}

function systemPrefersDark() {
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches === true;
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}

/** Aplica o tema no <html>. */
export function applyTheme() {
  if (typeof document === "undefined") return;
  const theme = resolveTheme(readThemeChoice(), systemPrefersDark());
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Sem armazenamento (aba privada): o tema vale só até recarregar.
  }
  applyTheme();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = window.matchMedia?.(DARK_QUERY);
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) {
      applyTheme();
      listener();
    }
  };
  const onSystem = () => {
    if (readThemeChoice() === "system") applyTheme();
    listener();
  };
  window.addEventListener("storage", onStorage);
  media?.addEventListener("change", onSystem);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
    media?.removeEventListener("change", onSystem);
  };
}

/** Escolha salva e o tema que está valendo agora. */
export function useTheme() {
  const choice = useSyncExternalStore<ThemeChoice>(subscribe, readThemeChoice, () => "light");
  const prefersDark = useSyncExternalStore(subscribe, systemPrefersDark, () => false);
  return { choice, theme: resolveTheme(choice, prefersDark), setChoice: setThemeChoice };
}
