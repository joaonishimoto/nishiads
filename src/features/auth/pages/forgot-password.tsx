import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/app/form-field";
import { LoadError } from "@/components/app/ui";
import { AuthLayout } from "@/features/auth/auth-layout";
import { forgotPasswordSchema } from "@/features/auth/schemas";
import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/lib/errors";
import { validate } from "@/lib/form";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validate(forgotPasswordSchema, { email });
    setError(result.errors?.email);
    if (!result.data) return;

    setSubmitting(true);
    setFormError(null);
    const { error: authError } = await supabase.auth.resetPasswordForEmail(result.data.email, {
      redirectTo: `${window.location.origin}/redefinir-senha`,
    });
    setSubmitting(false);
    if (authError) setFormError(friendlyError(authError));
    else setSent(true);
  }

  return (
    <AuthLayout
      title="Recuperar senha"
      subtitle={sent ? undefined : "Enviaremos um link para você criar uma nova senha."}
      footer={
        <Link to="/entrar" className="font-medium text-primary hover:underline">
          Voltar para o login
        </Link>
      }
    >
      {sent ? (
        <p className="text-sm text-muted-foreground">
          Se existir uma conta para <strong className="text-foreground">{email}</strong>, o link chega em
          instantes. Confira também a caixa de spam.
        </p>
      ) : (
        <form className="grid gap-4" onSubmit={onSubmit} noValidate>
          {formError && <LoadError>{formError}</LoadError>}
          <FormField label="E-mail" error={error}>
            <Input
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="voce@empresa.com.br"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </FormField>
          <Button type="submit" loading={submitting} loadingText="Enviando…">
            Enviar link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
