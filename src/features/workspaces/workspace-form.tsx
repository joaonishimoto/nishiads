import { useState, type FormEvent, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormField } from "@/components/app/form-field";
import {
  CURRENCIES,
  TIMEZONES,
  workspaceSchema,
  type WorkspaceFormValues,
} from "@/features/workspaces/schemas";
import { validate, type FieldErrors } from "@/lib/form";

export const DEFAULT_WORKSPACE_VALUES: WorkspaceFormValues = {
  name: "",
  timezone: "America/Sao_Paulo",
  currency: "BRL",
};

export function WorkspaceForm({
  initialValues = DEFAULT_WORKSPACE_VALUES,
  disabled = false,
  onSubmit,
  footer,
}: {
  initialValues?: WorkspaceFormValues;
  disabled?: boolean;
  onSubmit: (values: WorkspaceFormValues) => void;
  footer: ReactNode;
}) {
  const [values, setValues] = useState<WorkspaceFormValues>(initialValues);
  const [errors, setErrors] = useState<FieldErrors<WorkspaceFormValues>>({});

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validate(workspaceSchema, values);
    setErrors(result.errors ?? {});
    if (result.data) onSubmit(result.data);
  }

  return (
    <form className="grid gap-4" onSubmit={handleSubmit} noValidate>
      <fieldset disabled={disabled} className="grid gap-4">
        <FormField label="Nome do workspace" error={errors.name} hint="Ex.: o nome da sua empresa ou do cliente.">
          <Input
            placeholder="Ex.: Agência Nishi"
            value={values.name}
            maxLength={80}
            onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          />
        </FormField>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <FormField label="Fuso horário" error={errors.timezone} hint="Usado para fechar os relatórios do dia.">
            <Select
              value={values.timezone}
              onValueChange={(timezone) =>
                setValues((v) => ({ ...v, timezone: timezone as WorkspaceFormValues["timezone"] }))
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Selecione…" />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz.value} value={tz.value}>
                    {tz.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Moeda" error={errors.currency}>
            <Select
              value={values.currency}
              onValueChange={(currency) =>
                setValues((v) => ({ ...v, currency: currency as WorkspaceFormValues["currency"] }))
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Selecione…" />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
      </fieldset>
      {footer}
    </form>
  );
}
