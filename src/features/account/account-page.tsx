import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/app/form-field";
import { LoadError, PageHeader, Panel } from "@/components/app/ui";
import { useAuth, useUser } from "@/features/auth/auth-provider";
import { resetPasswordSchema } from "@/features/auth/schemas";
import { SettingsNav } from "@/features/workspaces/pages/settings-nav";
import { workspaceKeys } from "@/features/workspaces/api";
import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/lib/errors";
import { validate, type FieldErrors } from "@/lib/form";

const profileSchema = z.object({
  fullName: z.string().trim().min(2, "Informe seu nome.").max(120, "Nome muito longo."),
});

function useProfile(userId: string) {
  return useQuery({
    queryKey: ["profile", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, email, full_name")
        .eq("id", userId)
        .single();
      if (error) throw error;
      return data;
    },
  });
}

export function AccountPage() {
  const { signOut } = useAuth();
  return (
    <div className="space-y-6">
      <PageHeader title="Ajustes" subtitle="Dados do workspace, equipe e sua conta." />
      <SettingsNav />
      <ProfilePanel />
      <PasswordPanel />
      <Panel title="Sessão">
        <div className="flex items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">Sair deste dispositivo.</p>
          <Button variant="outline" onClick={() => signOut()}>
            Sair
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function ProfilePanel() {
  const user = useUser();
  const qc = useQueryClient();
  const profile = useProfile(user.id);
  const [fullName, setFullName] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: async (name: string) => {
      const { error: dbError } = await supabase.from("profiles").update({ full_name: name }).eq("id", user.id);
      if (dbError) throw dbError;
      await supabase.auth.updateUser({ data: { full_name: name } });
    },
    onSuccess: () => {
      toast.success("Nome atualizado.");
      qc.invalidateQueries({ queryKey: ["profile", user.id] });
      qc.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  });

  if (profile.isError) {
    return (
      <LoadError onRetry={() => profile.refetch()} retrying={profile.isFetching}>
        Não foi possível carregar seu perfil.
      </LoadError>
    );
  }

  const value = fullName ?? profile.data?.full_name ?? "";

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validate(profileSchema, { fullName: value });
    setError(result.errors?.fullName);
    if (result.data) save.mutate(result.data.fullName);
  }

  return (
    <Panel title="Perfil">
      <form className="grid gap-4 p-4" onSubmit={onSubmit} noValidate>
        {save.isError && <LoadError>{friendlyError(save.error)}</LoadError>}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <FormField label="Nome" error={error}>
            <Input
              placeholder="Ex.: Maria Souza"
              autoComplete="name"
              value={value}
              disabled={profile.isPending}
              onChange={(e) => setFullName(e.target.value)}
            />
          </FormField>
          <FormField label="E-mail" hint="O e-mail de login não pode ser alterado por aqui.">
            <Input placeholder="voce@empresa.com.br" value={user.email ?? ""} readOnly disabled />
          </FormField>
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending} loadingText="Salvando…">
            Salvar nome
          </Button>
        </div>
      </form>
    </Panel>
  );
}

type PasswordValues = { password: string; confirmPassword: string };

function PasswordPanel() {
  const [values, setValues] = useState<PasswordValues>({ password: "", confirmPassword: "" });
  const [errors, setErrors] = useState<FieldErrors<PasswordValues>>({});
  const change = useMutation({
    mutationFn: async (password: string) => {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Senha alterada.");
      setValues({ password: "", confirmPassword: "" });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validate(resetPasswordSchema, values);
    setErrors(result.errors ?? {});
    if (result.data) change.mutate(result.data.password);
  }

  return (
    <Panel title="Senha">
      <form className="grid gap-4 p-4" onSubmit={onSubmit} noValidate>
        {change.isError && <LoadError>{friendlyError(change.error)}</LoadError>}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
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
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={change.isPending} loadingText="Alterando…">
            Alterar senha
          </Button>
        </div>
      </form>
    </Panel>
  );
}
