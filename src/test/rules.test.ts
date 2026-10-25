import { describe, expect, it } from "vitest";
import { signUpSchema } from "@/features/auth/schemas";
import { safeNext } from "@/features/auth/route-guards";
import { assignableRoles, canManageMember, inviteSchema, workspaceSchema } from "@/features/workspaces/schemas";
import { friendlyError } from "@/lib/errors";
import { formatMoney, plural } from "@/lib/format";
import { validate } from "@/lib/form";

describe("formatação pt-BR", () => {
  it("formata centavos em BRL", () => {
    expect(formatMoney(19700)).toBe("R$ 197,00");
    expect(formatMoney(123456789)).toBe("R$ 1.234.567,89");
  });
  it("pluraliza", () => {
    expect(plural(1, "venda", "vendas")).toBe("1 venda");
    expect(plural(1200, "venda", "vendas")).toBe("1.200 vendas");
  });
});

describe("cadastro", () => {
  it("exige senhas iguais e fortes", () => {
    const weak = validate(signUpSchema, { fullName: "Ana", email: "a@b.com", password: "abc", confirmPassword: "abc" });
    expect(weak.errors?.password).toBeDefined();
    const mismatch = validate(signUpSchema, {
      fullName: "Ana",
      email: "a@b.com",
      password: "senha1234",
      confirmPassword: "senha12345",
    });
    expect(mismatch.errors?.confirmPassword).toBe("As senhas não conferem.");
  });
  it("normaliza o e-mail", () => {
    const ok = validate(signUpSchema, {
      fullName: " Ana ",
      email: " Ana@Empresa.COM ",
      password: "senha1234",
      confirmPassword: "senha1234",
    });
    expect(ok.data?.email).toBe("ana@empresa.com");
    expect(ok.data?.fullName).toBe("Ana");
  });
});

describe("workspace", () => {
  it("aceita só fusos e moedas da lista", () => {
    expect(validate(workspaceSchema, { name: "X", timezone: "America/Sao_Paulo", currency: "BRL" }).data).toBeTruthy();
    expect(validate(workspaceSchema, { name: "X", timezone: "Mars/Base", currency: "BRL" }).errors?.timezone).toBeDefined();
    expect(validate(workspaceSchema, { name: "  ", timezone: "UTC", currency: "BRL" }).errors?.name).toBeDefined();
  });
  it("convite valida e-mail", () => {
    expect(validate(inviteSchema, { email: "x", role: "viewer" }).errors?.email).toBeDefined();
  });
});

describe("papéis (espelho das RPCs)", () => {
  it("só owner concede owner", () => {
    expect(assignableRoles("owner")).toContain("owner");
    expect(assignableRoles("admin")).not.toContain("owner");
    expect(assignableRoles("viewer")).toEqual([]);
  });
  it("admin não mexe em owner nem em si mesmo", () => {
    expect(canManageMember("admin", { role: "owner", isSelf: false })).toBe(false);
    expect(canManageMember("admin", { role: "viewer", isSelf: false })).toBe(true);
    expect(canManageMember("owner", { role: "owner", isSelf: true })).toBe(false);
    expect(canManageMember("viewer", { role: "viewer", isSelf: false })).toBe(false);
  });
});

describe("segurança de navegação e erros", () => {
  it("bloqueia open redirect em ?next=", () => {
    expect(safeNext("/w/123")).toBe("/w/123");
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
  it("traduz erros conhecidos e esconde os desconhecidos", () => {
    expect(friendlyError({ code: "invalid_credentials", message: "Invalid login credentials" })).toBe(
      "E-mail ou senha incorretos.",
    );
    expect(friendlyError({ code: "42501", message: "Você não tem permissão para esta ação neste workspace." })).toBe(
      "Você não tem permissão para esta ação neste workspace.",
    );
    expect(friendlyError({ code: "XX000", message: "internal stack trace" })).toBe("Algo deu errado. Tente novamente.");
  });
});
