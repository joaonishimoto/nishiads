import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { useUpdateProductCost } from "@/features/results/data";
import type { ProductCost } from "@/features/results/metrics";
import { friendlyError } from "@/lib/errors";

type Draft = { value: number; cost: number; feePct: string; feeFixed: number };

const toDraft = (p: ProductCost): Draft => ({
  value: (p.sale_value_cents ?? 0) / 100,
  cost: p.cost_cents / 100,
  feePct: p.fee_percent_bps ? String(p.fee_percent_bps / 100).replace(".", ",") : "",
  feeFixed: p.fee_fixed_cents / 100,
});

/** Custo e taxas por produto: entram no lucro de cada venda aprovada. */
export function ProductCostsDialog({
  open,
  onOpenChange,
  products,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: ProductCost[];
}) {
  const { workspace, canManage } = useWorkspace();
  const update = useUpdateProductCost(workspace.id);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  useEffect(() => {
    if (open) setDrafts(Object.fromEntries(products.map((p) => [p.id, toDraft(p)])));
  }, [open, products]);

  const changed = products.filter((p) => {
    const d = drafts[p.id];
    if (!d) return false;
    const o = toDraft(p);
    return (
      d.value !== o.value || d.cost !== o.cost || d.feePct !== o.feePct || d.feeFixed !== o.feeFixed
    );
  });

  const save = async () => {
    try {
      for (const p of changed) {
        const d = drafts[p.id]!;
        const pct = Number(d.feePct.replace(",", ".") || 0);
        await update.mutateAsync({
          id: p.id,
          sale_value_cents: d.value > 0 ? Math.round(d.value * 100) : null,
          cost_cents: Math.round(d.cost * 100),
          fee_percent_bps: Math.min(
            10_000,
            Math.max(0, Math.round((Number.isFinite(pct) ? pct : 0) * 100)),
          ),
          fee_fixed_cents: Math.round(d.feeFixed * 100),
        });
      }
      toast.success("Produtos salvos. Ganhos e lucro já foram recalculados.");
      onOpenChange(false);
    } catch (error) {
      toast.error(friendlyError(error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Valores e custos dos produtos</DialogTitle>
          <DialogDescription>
            O valor por venda dá valor aos testes em andamento (vazio: preço da última venda
            aprovada). Lucro = faturamento − taxas − custo do produto − gasto em anúncios. Sem taxa
            preenchida, usamos o valor líquido que o checkout informa.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {products.length === 0 ? (
            <EmptyState
              compact
              icon={Package}
              title="Nenhum produto ainda"
              description="Os produtos aparecem aqui sozinhos quando a primeira venda de cada um chega pelo webhook."
            />
          ) : (
            products.map((p) => {
              const d = drafts[p.id] ?? toDraft(p);
              const set = (patch: Partial<Draft>) =>
                setDrafts((all) => ({ ...all, [p.id]: { ...d, ...patch } }));
              return (
                <fieldset
                  key={p.id}
                  className="rounded-lg border border-border p-3"
                  disabled={!canManage}
                >
                  <legend className="sr-only">{p.name}</legend>
                  <p className="mb-2.5 truncate text-sm font-medium text-foreground" aria-hidden>
                    {p.name}
                  </p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="space-y-1">
                      <Label htmlFor={`value-${p.id}`} className="text-xs">
                        Valor por venda
                      </Label>
                      <MoneyInput
                        id={`value-${p.id}`}
                        currency={workspace.currency}
                        value={d.value}
                        onChange={(v) => set({ value: v })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`cost-${p.id}`} className="text-xs">
                        Custo por venda
                      </Label>
                      <MoneyInput
                        id={`cost-${p.id}`}
                        currency={workspace.currency}
                        value={d.cost}
                        onChange={(v) => set({ cost: v })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`pct-${p.id}`} className="text-xs">
                        Taxa (%)
                      </Label>
                      <Input
                        id={`pct-${p.id}`}
                        inputMode="decimal"
                        placeholder="Ex.: 9,9"
                        value={d.feePct}
                        onChange={(e) =>
                          set({ feePct: e.target.value.replace(/[^\d,.]/g, "").slice(0, 6) })
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`fixed-${p.id}`} className="text-xs">
                        Taxa fixa
                      </Label>
                      <MoneyInput
                        id={`fixed-${p.id}`}
                        currency={workspace.currency}
                        value={d.feeFixed}
                        onChange={(v) => set({ feeFixed: v })}
                      />
                    </div>
                  </div>
                </fieldset>
              );
            })
          )}
          {!canManage && products.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Só owners e admins podem mudar valores e custos.
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {canManage ? "Cancelar" : "Fechar"}
          </Button>
          {canManage && (
            <Button
              onClick={save}
              disabled={changed.length === 0}
              loading={update.isPending}
              loadingText="Salvando…"
            >
              Salvar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
