import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/app/form-field";
import { LoadError } from "@/components/app/ui";
import { AuthLayout } from "@/features/auth/auth-layout";
import { signInSchema } from "@/features/auth/schemas";
import { safeNext } from "@/features/auth/route-guards";
import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/lib/errors";
import { validate, type FieldErrors } from "@/lib/form";

type Values = { email: string; password: string };

export function SignInPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [values, setValues] = useState<Values>({ email: "", password: "" });
  const [errors, setErrors] = useState<FieldErrors<Values>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validate(signInSchema, values);
    setErrors(result.errors ?? {});
    if (!result.data) return;

    setSubmitting(true);
    setFormError(null);
    const { error } = await supabase.auth.signInWithPassword(result.data);
    setSubmitting(false);
    if (error) {
      setFormError(friendlyError(error));
      return;
    }
    navigate(safeNext(params.get("next")), { replace: true });
  }

  return (
    <AuthLayout
      title="Entrar"
      subtitle="Acompanhe suas vendas e campanhas."
    >
      <form className="grid gap-4" onSubmit={onSubmit} noValidate>
        {formError && <LoadError>{formError}</LoadError>}
        <FormField label="E-mail" error={errors.email}>
          <Input
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="voce@empresa.com.br"
            value={values.email}
            onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))}
          />
        </FormField>
        <FormField label="Senha" error={errors.password}>
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="Sua senha"
            value={values.password}
            onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
          />
        </FormField>
        <Button type="submit" loading={submitting} loadingText="Entrando…">
          Entrar
        </Button>
      </form>
    </AuthLayout>
  );
}
