import { z } from "zod";

const email = z.string().trim().toLowerCase().email("Informe um e-mail válido.");
const password = z
  .string()
  .min(8, "Use pelo menos 8 caracteres.")
  .max(72, "Use no máximo 72 caracteres.")
  .regex(/[a-zA-Z]/, "Inclua pelo menos uma letra.")
  .regex(/\d/, "Inclua pelo menos um número.");

export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Informe sua senha."),
});

export const signUpSchema = z
  .object({
    fullName: z.string().trim().min(2, "Informe seu nome.").max(120, "Nome muito longo."),
    email,
    password,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "As senhas não conferem.",
  });

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z
  .object({ password, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "As senhas não conferem.",
  });
