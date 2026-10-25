import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/app/form-field";
import { FullScreenLoader, LoadError } from "@/components/app/ui";
import { AuthLayout } from "@/features/auth/auth-layout";
import { useAuth } from "@/features/auth/auth-provider";
import { resetPasswordSchema } from "@/features/auth/schemas";
import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/lib/errors";
import { validate, type FieldErrors } from "@/lib/form";

type Values = { password: string; confirmPassword: string };

export function ResetPasswordPage() {
  const { session, loading, finishRecovery } = useAuth();
  const navigate = useNavigate();
  const [values, setValues] = useState<Values>({ password: "", confirmPassword: "" });
  const [errors, setErrors] = useState<FieldErrors<Values>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) return <FullScreenLoader />;

  if (!session) {
    return (
      <AuthLayout title="Link inválido ou expirado">
        <p className="text-sm text-muted-foreground">
          Peça um novo link de recuperação para criar sua senha.
        </p>
        <Link to="/recuperar-senha" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
          Pedir novo link
        </Link>
      </AuthLayout>
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validate(resetPasswordSchema, values);
    setErrors(result.errors ?? {});
    if (!result.data) return;

    setSubmitting(true);
    setFormError(null);
    const { error } = await supabase.auth.updateUser({ password: result.data.password });
    setSubmitting(false);
    if (error) {
      setFormError(friendlyError(error));
      return;
    }
    toast.success("Senha atualizada.");
    finishRecovery();
    navigate("/", { replace: true });
  }

  return (
    <AuthLayout title="Nova senha">
      <form className="grid gap-4" onSubmit={onSubmit} noValidate>
        {formError && <LoadError>{formError}</LoadError>}
        <FormField label="Nova senha" error={errors.password} hint="Mínimo de 8 caracteres, com letras e números.">
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="Crie uma senha"
            value={values.password}
            onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
          />
        </FormField>
        <FormField label="Confirmar senha" error={errors.confirmPassword}>
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="Repita a senha"
            value={values.confirmPassword}
            onChange={(e) => setValues((v) => ({ ...v, confirmPassword: e.target.value }))}
          />
        </FormField>
        <Button type="submit" loading={submitting} loadingText="Salvando…">
          Salvar nova senha
        </Button>
      </form>
    </AuthLayout>
  );
}
