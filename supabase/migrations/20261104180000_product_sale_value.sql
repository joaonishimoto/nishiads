-- Nishiads · Valor por venda de cada produto.
--
-- Um teste grátis entra em sales como trialing, com valor zero. O Dashboard projeta
-- quanto ele vale pelo preço da última venda aprovada do produto, mas um produto que
-- ainda não teve venda aprovada (ou cujo preço varia) ficava sem valor. Agora o owner
-- ou admin informa o valor de cada venda do produto, e esse valor manda: os testes em
-- andamento passam a valer isso nos cartões Ganhos e ROAS com testes.
--
-- Vazio (null) mantém o comportamento de antes: o preço da última venda aprovada.

alter table public.products
  add column if not exists sale_value_cents bigint
    check (sale_value_cents is null or sale_value_cents >= 0);

comment on column public.products.sale_value_cents is
  'Valor de referência de cada venda do produto (centavos, moeda da conta). Usado para dar valor aos testes em andamento. Null = preço da última venda aprovada.';

-- Drinfy: cada venda vale cerca de R$ 67,00.
update public.products p
set sale_value_cents = 6700
from public.workspaces w
where w.id = p.workspace_id
  and w.name ilike '%drinfy%'
  and p.sale_value_cents is null;
