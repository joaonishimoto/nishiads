-- Nishiads · Testes iniciados (assinaturas com período de teste).
--
-- O teste entra como uma "venda" de status trialing e valor zero, identificada pela
-- assinatura (sub_... na Stripe), com as UTMs do checkout: assim ele já aparece ligado
-- ao anúncio. Quando chega a primeira cobrança paga da mesma assinatura, o teste é
-- marcado como convertido e aponta para a venda aprovada.
--
-- Rode este arquivo inteiro de uma vez no SQL Editor. O novo valor do enum só é usado
-- como texto aqui dentro, porque o Postgres não deixa usar um valor de enum na mesma
-- transação em que ele foi criado.

alter type public.sale_status add value if not exists 'trialing';

alter table public.sales
  add column trial_converted_at timestamptz,
  add column converted_sale_id uuid references public.sales (id) on delete set null;

comment on column public.sales.trial_converted_at is 'Teste: quando a primeira cobrança paga da assinatura chegou.';
comment on column public.sales.converted_sale_id is 'Teste: a venda aprovada em que ele se converteu.';

create index sales_converted_sale_id_idx on public.sales (converted_sale_id) where converted_sale_id is not null;

-- Teste fica no mesmo degrau de pendente: qualquer status real vence.
create or replace function private.sale_status_rank(p_status public.sale_status)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status::text
    when 'trialing' then 0
    when 'pending' then 0
    when 'canceled' then 1
    when 'approved' then 2
    when 'refunded' then 3
    when 'chargeback' then 4
  end;
$$;

-- p_sale ganha o campo opcional subscription_ref: a assinatura da venda. Se existir um
-- teste dessa assinatura, a venda aprovada converte o teste e herda as UTMs dele quando
-- chegou sem nenhuma.
create or replace function public.service_ingest_sale(
  p_workspace_id uuid,
  p_checkout_integration_id uuid,
  p_provider public.checkout_provider,
  p_sale jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_external_order_id text := nullif(btrim(p_sale ->> 'external_order_id'), '');
  v_subscription_ref text := nullif(btrim(p_sale ->> 'subscription_ref'), '');
  v_product_id uuid;
  v_previous public.sale_status;
  v_sale_id uuid;
  v_status public.sale_status;
  v_inserted boolean;
  v_attribution public.attribution_status;
  v_trial public.sales;
begin
  if v_external_order_id is null then
    raise exception 'external_order_id ausente' using errcode = '22023';
  end if;

  if nullif(p_sale ->> 'external_product_id', '') is not null then
    insert into public.products (workspace_id, provider, external_product_id, name)
    values (
      p_workspace_id,
      p_provider,
      p_sale ->> 'external_product_id',
      left(coalesce(nullif(btrim(p_sale ->> 'product_name'), ''), 'Produto ' || (p_sale ->> 'external_product_id')), 200)
    )
    on conflict (workspace_id, provider, external_product_id)
    do update set name = public.products.name
    returning id into v_product_id;
  end if;

  -- O teste da mesma assinatura (quando esta venda não é o próprio teste).
  if v_subscription_ref is not null
     and v_subscription_ref <> v_external_order_id
     and p_sale ->> 'status' = 'approved' then
    select * into v_trial
    from public.sales s
    where s.workspace_id = p_workspace_id
      and s.provider = p_provider
      and s.external_order_id = v_subscription_ref
      and s.status::text = 'trialing'
    for update;
  end if;

  select s.status into v_previous
  from public.sales s
  where s.workspace_id = p_workspace_id
    and s.provider = p_provider
    and s.external_order_id = v_external_order_id
  for update;

  insert into public.sales as s (
    workspace_id, checkout_integration_id, provider, external_order_id, status,
    gross_amount_cents, net_amount_cents, currency, product_id, external_product_id, product_name,
    customer_email_hash, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    paid_at, refunded_at, raw_payload
  )
  values (
    p_workspace_id,
    p_checkout_integration_id,
    p_provider,
    v_external_order_id,
    (p_sale ->> 'status')::public.sale_status,
    (p_sale ->> 'gross_amount_cents')::bigint,
    (p_sale ->> 'net_amount_cents')::bigint,
    coalesce(nullif(p_sale ->> 'currency', ''), 'BRL'),
    v_product_id,
    nullif(p_sale ->> 'external_product_id', ''),
    nullif(left(p_sale ->> 'product_name', 200), ''),
    nullif(p_sale ->> 'customer_email_hash', ''),
    nullif(left(p_sale ->> 'utm_source', 500), ''),
    nullif(left(p_sale ->> 'utm_medium', 500), ''),
    nullif(left(p_sale ->> 'utm_campaign', 500), ''),
    nullif(left(p_sale ->> 'utm_content', 500), ''),
    nullif(left(p_sale ->> 'utm_term', 500), ''),
    (p_sale ->> 'paid_at')::timestamptz,
    (p_sale ->> 'refunded_at')::timestamptz,
    coalesce(p_sale -> 'raw_payload', '{}'::jsonb)
  )
  on conflict (workspace_id, provider, external_order_id) do update set
    status = case
      when private.sale_status_rank(excluded.status) >= private.sale_status_rank(s.status) then excluded.status
      else s.status
    end,
    raw_payload = case
      when private.sale_status_rank(excluded.status) >= private.sale_status_rank(s.status) then excluded.raw_payload
      else s.raw_payload
    end,
    gross_amount_cents = excluded.gross_amount_cents,
    net_amount_cents = coalesce(excluded.net_amount_cents, s.net_amount_cents),
    currency = excluded.currency,
    checkout_integration_id = coalesce(excluded.checkout_integration_id, s.checkout_integration_id),
    product_id = coalesce(excluded.product_id, s.product_id),
    external_product_id = coalesce(excluded.external_product_id, s.external_product_id),
    product_name = coalesce(excluded.product_name, s.product_name),
    customer_email_hash = coalesce(excluded.customer_email_hash, s.customer_email_hash),
    utm_source = coalesce(excluded.utm_source, s.utm_source),
    utm_medium = coalesce(excluded.utm_medium, s.utm_medium),
    utm_campaign = coalesce(excluded.utm_campaign, s.utm_campaign),
    utm_content = coalesce(excluded.utm_content, s.utm_content),
    utm_term = coalesce(excluded.utm_term, s.utm_term),
    paid_at = coalesce(excluded.paid_at, s.paid_at),
    refunded_at = coalesce(excluded.refunded_at, s.refunded_at)
  returning s.id, s.status, (s.xmax = 0) into v_sale_id, v_status, v_inserted;

  if v_trial.id is not null then
    -- Venda sem UTMs herda as do teste (o checkout do teste é que veio do anúncio).
    update public.sales s set
      utm_source = v_trial.utm_source,
      utm_medium = v_trial.utm_medium,
      utm_campaign = v_trial.utm_campaign,
      utm_content = v_trial.utm_content,
      utm_term = v_trial.utm_term
    where s.id = v_sale_id
      and coalesce(s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term) is null;

    -- Só a primeira cobrança converte; as renovações seguintes não mexem no teste.
    update public.sales s set
      trial_converted_at = coalesce((p_sale ->> 'paid_at')::timestamptz, now()),
      converted_sale_id = v_sale_id
    where s.id = v_trial.id
      and s.converted_sale_id is null;
  end if;

  v_attribution := private.attribute_sale(v_sale_id);

  return jsonb_build_object(
    'sale_id', v_sale_id,
    'status', v_status,
    'previous_status', v_previous,
    'inserted', v_inserted,
    'attribution_status', v_attribution,
    'converted_trial_id', v_trial.id
  );
end;
$$;

revoke all on function public.service_ingest_sale(uuid, uuid, public.checkout_provider, jsonb) from public, anon, authenticated;
grant execute on function public.service_ingest_sale(uuid, uuid, public.checkout_provider, jsonb) to service_role;
