import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Check, Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckboxMark } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormField } from "@/components/app/form-field";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import {
  useDeleteTemplate,
  useSaveTemplate,
  useSelectTemplate,
  useViewTemplates,
  type ViewTemplate,
} from "@/features/views/api";
import {
  editorOrder,
  itemsToSave,
  moveWithinGroup,
  resolveItems,
  type ViewCatalog,
} from "@/features/views/catalog";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import type { ViewTemplatePage } from "@/types/database";

const DEFAULT_NAME = "Padrão";

/** Métricas ou colunas que a tela mostra, segundo o template escolhido pelo usuário. */
export function useViewItems(page: ViewTemplatePage, catalog: ViewCatalog) {
  const { workspace } = useWorkspace();
  const templates = useViewTemplates(workspace.id, page);
  const active = templates.data?.find((t) => t.is_default) ?? null;
  const items = useMemo(() => resolveItems(active?.items, catalog), [active, catalog]);
  const shown = useMemo(() => new Set(items), [items]);
  return { items, shown, active };
}

/** Botão “Visualização”: troca de template, cria, edita e apaga. */
export function ViewPicker({
  page,
  catalog,
  className,
}: {
  page: ViewTemplatePage;
  catalog: ViewCatalog;
  className?: string;
}) {
  const { workspace } = useWorkspace();
  const templates = useViewTemplates(workspace.id, page);
  const select = useSelectTemplate(workspace.id, page);
  const { items, active } = useViewItems(page, catalog);
  // null: fechado · "new": novo template · template: editando.
  const [editing, setEditing] = useState<ViewTemplate | "new" | null>(null);
  const list = templates.data ?? [];

  const pick = (id: string | null) =>
    select.mutate(id, { onError: (error) => toast.error(friendlyError(error)) });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className={cn("max-w-56", className)}>
            <SlidersHorizontal />
            <span className="truncate">{active?.name ?? "Personalizar"}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Seus templates
          </DropdownMenuLabel>
          <TemplateItem
            name={DEFAULT_NAME}
            hint="tudo"
            checked={!active}
            onSelect={() => pick(null)}
          />
          {list.map((t) => (
            <TemplateItem
              key={t.id}
              name={t.name}
              checked={active?.id === t.id}
              onSelect={() => pick(t.id)}
            />
          ))}
          <DropdownMenuSeparator />
          {active && (
            <DropdownMenuItem onSelect={() => setEditing(active)}>
              <Pencil />
              Editar “{active.name}”
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setEditing("new")}>
            <Plus />
            Novo template
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {editing && (
        <TemplateDialog
          page={page}
          catalog={catalog}
          template={editing === "new" ? null : editing}
          startItems={items}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function TemplateItem({
  name,
  hint,
  checked,
  onSelect,
}: {
  name: string;
  hint?: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className={cn(checked && "text-primary")}>
      <Check className={cn(!checked && "invisible")} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </DropdownMenuItem>
  );
}

function TemplateDialog({
  page,
  catalog,
  template,
  startItems,
  onClose,
}: {
  page: ViewTemplatePage;
  catalog: ViewCatalog;
  template: ViewTemplate | null;
  /** Novo template começa do que está na tela agora. */
  startItems: string[];
  onClose: () => void;
}) {
  const { workspace } = useWorkspace();
  const save = useSaveTemplate(workspace.id, page);
  const remove = useDeleteTemplate(workspace.id, page);
  const initial = template ? resolveItems(template.items, catalog) : startItems;
  const [name, setName] = useState(template?.name ?? "");
  const [order, setOrder] = useState(() => editorOrder(initial, catalog));
  const [selected, setSelected] = useState(() => new Set(initial));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const label = (key: string) => catalog.options.find((o) => o.key === key)!;

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Dê um nome ao template.");
      return;
    }
    const items = itemsToSave(order, selected, catalog);
    if (items.length === 0) {
      toast.error("Escolha ao menos um item.");
      return;
    }
    save.mutate(
      { id: template?.id ?? null, values: { name: trimmed, items } },
      {
        onSuccess: () => {
          toast.success(template ? "Template salvo." : `Template “${trimmed}” criado.`);
          onClose();
        },
        onError: (error) => toast.error(friendlyError(error)),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{template ? "Editar template" : "Novo template"}</DialogTitle>
          <DialogDescription>
            {page === "dashboard"
              ? "Escolha as métricas e as seções do Dashboard e a ordem dos cartões."
              : "Escolha as colunas da tabela de campanhas, conjuntos e anúncios e a ordem delas."}{" "}
            Só você vê os seus templates.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <FormField label="Nome" error={nameError ?? undefined}>
            <Input
              value={name}
              maxLength={60}
              autoFocus={!template}
              placeholder={page === "dashboard" ? "Ex.: Só tráfego" : "Ex.: Enxuto"}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
            />
          </FormField>
          {catalog.groups.map((g) => {
            const keys = order.filter((k) => label(k).group === g.key);
            return (
              <fieldset key={g.key} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <legend className="text-xs font-medium text-muted-foreground">{g.label}</legend>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {keys.filter((k) => selected.has(k)).length} de {keys.length}
                  </span>
                </div>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {keys.map((key, i) => {
                    const opt = label(key);
                    const on = selected.has(key);
                    return (
                      <li key={key} className="flex items-center gap-1 pr-1.5">
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          onClick={() => toggle(key)}
                          className="group flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left text-sm focus-visible:outline-none"
                        >
                          <CheckboxMark checked={on} />
                          <span
                            className={cn(
                              "truncate",
                              on ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            {opt.label}
                          </span>
                          {opt.hint && (
                            <span className="truncate text-xs text-muted-foreground">
                              {opt.hint}
                            </span>
                          )}
                        </button>
                        {g.reorder && (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label={`Subir ${opt.label}`}
                              disabled={i === 0}
                              onClick={() => setOrder((o) => moveWithinGroup(o, key, -1, catalog))}
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label={`Descer ${opt.label}`}
                              disabled={i === keys.length - 1}
                              onClick={() => setOrder((o) => moveWithinGroup(o, key, 1, catalog))}
                            >
                              <ArrowDown />
                            </Button>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            );
          })}
          <button
            type="button"
            className="text-xs font-medium text-primary hover:underline"
            onClick={() => {
              setOrder(editorOrder(catalog.defaults, catalog));
              setSelected(new Set(catalog.defaults));
            }}
          >
            Voltar para o padrão
          </button>
        </DialogBody>
        <DialogFooter className="sm:justify-between">
          {template ? (
            <Button
              variant={confirmDelete ? "destructive" : "ghost"}
              loading={remove.isPending}
              loadingText="Apagando…"
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                remove.mutate(template.id, {
                  onSuccess: () => {
                    toast.success("Template apagado. A tela volta para o padrão.");
                    onClose();
                  },
                  onError: (error) => toast.error(friendlyError(error)),
                });
              }}
            >
              <Trash2 />
              {confirmDelete ? "Confirmar e apagar" : "Apagar"}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2 [&>*]:flex-1 sm:[&>*]:flex-none">
            <Button variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button loading={save.isPending} loadingText="Salvando…" onClick={submit}>
              {template ? "Salvar" : "Criar e usar"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
