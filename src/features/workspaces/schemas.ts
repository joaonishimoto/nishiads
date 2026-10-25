import { z } from "zod";
import type { WorkspaceRole } from "@/types/database";

export const TIMEZONES = [
  { value: "America/Sao_Paulo", label: "Brasília (São Paulo, Rio, Sul, Nordeste)" },
  { value: "America/Manaus", label: "Amazonas (Manaus)" },
  { value: "America/Cuiaba", label: "Mato Grosso (Cuiabá)" },
  { value: "America/Campo_Grande", label: "Mato Grosso do Sul (Campo Grande)" },
  { value: "America/Porto_Velho", label: "Rondônia (Porto Velho)" },
  { value: "America/Boa_Vista", label: "Roraima (Boa Vista)" },
  { value: "America/Rio_Branco", label: "Acre (Rio Branco)" },
  { value: "America/Noronha", label: "Fernando de Noronha" },
  { value: "Europe/Lisbon", label: "Portugal (Lisboa)" },
  { value: "UTC", label: "UTC" },
] as const;

export const CURRENCIES = [
  { value: "BRL", label: "Real (R$)" },
  { value: "USD", label: "Dólar americano (US$)" },
  { value: "EUR", label: "Euro (€)" },
] as const;

type TimezoneValue = (typeof TIMEZONES)[number]["value"];
type CurrencyValue = (typeof CURRENCIES)[number]["value"];

export const workspaceSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome ao workspace.").max(80, "Use no máximo 80 caracteres."),
  timezone: z.enum(TIMEZONES.map((t) => t.value) as [TimezoneValue, ...TimezoneValue[]], {
    errorMap: () => ({ message: "Escolha um fuso horário." }),
  }),
  currency: z.enum(CURRENCIES.map((c) => c.value) as [CurrencyValue, ...CurrencyValue[]], {
    errorMap: () => ({ message: "Escolha uma moeda." }),
  }),
});

export type WorkspaceFormValues = z.infer<typeof workspaceSchema>;

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  viewer: "Leitura",
};

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: "Controle total, inclusive excluir o workspace.",
  admin: "Conecta contas, integrações e gerencia membros.",
  viewer: "Vê vendas, campanhas e relatórios.",
};

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Informe um e-mail válido."),
  role: z.enum(["owner", "admin", "viewer"]),
});

export type InviteFormValues = z.infer<typeof inviteSchema>;

/** Papéis que quem chama pode atribuir: só owner concede owner. */
export function assignableRoles(callerRole: WorkspaceRole): WorkspaceRole[] {
  if (callerRole === "owner") return ["owner", "admin", "viewer"];
  if (callerRole === "admin") return ["admin", "viewer"];
  return [];
}

/** Espelha as regras das RPCs para esconder ações que o banco recusaria. */
export function canManageMember(
  callerRole: WorkspaceRole,
  target: { role: WorkspaceRole; isSelf: boolean },
): boolean {
  if (target.isSelf) return false;
  if (callerRole === "owner") return true;
  if (callerRole === "admin") return target.role !== "owner";
  return false;
}
