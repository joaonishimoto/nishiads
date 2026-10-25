import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/app/form-field";
import { LoadError } from "@/components/app/ui";
import { AuthLayout } from "@/features/auth/auth-layout";
import { signUpSchema } from "@/features/auth/schemas";
import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/lib/errors";
import { validate, type FieldErrors } from "@/lib/form";

type Values = { fullName: string; email: string; password: string; confirmPassword: string };

export function SignUpPage() {
  const navigate = useNavigate();
  const [values, setValues] = useState<Values>({
    fullName: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [errors, setErrors] = useState<FieldErrors<Values>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const set = (key: keyof Values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validate(signUpSchema, values);
    setErrors(result.errors ?? {});
    if (!result.data) return;

    setSubmitting(true);
    setFormError(null);
    const { data, error } = await supabase.auth.signUp({
      email: result.data.email,
      password: result.data.password,
      options: {
        data: { full_name: result.data.fullName },
        emailRedirectTo: `${window.location.origin}/`,
      },
    });
    setSubmitting(false);
    if (error) {
      setFormError(friendlyError(error));
      return;
    }
    // Com confirmação de e-mail ligada, não há sessão até o usuário clicar no link.
    if (data.session) navigate("/", { replace: true });
    else setSentTo(result.data.email);
  }

  if (sentTo) {
    return (
      <AuthLayout title="Confirme seu e-mail">
        <div className="flex flex-col items-center gap-3 text-center">
          <MailCheck className="h-8 w-8 text-primary" aria-hidden />
          <p className="text-sm text-muted-foreground">
            Enviamos um link de confirmação para <strong className="text-foreground">{sentTo}</strong>.
            Abra o e-mail para ativar sua conta.
          </p>
          <Link to="/entrar" className="text-sm font-medium text-primary hover:underline">
            Voltar para o login
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Criar conta"
      subtitle="Leva menos de um minuto."
      footer={
        <>
          Já tem conta?{" "}
          <Link to="/entrar" className="font-medium text-primary hover:underline">
            Entrar
          </Link>
        </>
      }
    >
      <form className="grid gap-4" onSubmit={onSubmit} noValidate>
        {formError && <LoadError>{formError}</LoadError>}
        <FormField label="Nome" error={errors.fullName}>
          <Input autoComplete="name" placeholder="Ex.: Maria Souza" value={values.fullName} onChange={set("fullName")} />
        </FormField>
        <FormField label="E-mail" error={errors.email}>
          <Input
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="voce@empresa.com.br"
            value={values.email}
            onChange={set("email")}
          />
        </FormField>
        <FormField label="Senha" error={errors.password} hint="Mínimo de 8 caracteres, com letras e números.">
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="Crie uma senha"
            value={values.password}
            onChange={set("password")}
          />
        </FormField>
        <FormField label="Confirmar senha" error={errors.confirmPassword}>
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="Repita a senha"
            value={values.confirmPassword}
            onChange={set("confirmPassword")}
          />
        </FormField>
        <Button type="submit" loading={submitting} loadingText="Criando conta…">
          Criar conta
        </Button>
      </form>
    </AuthLayout>
  );
}
