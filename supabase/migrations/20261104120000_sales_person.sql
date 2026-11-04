-- Nishiads · A venda herda o anúncio do cadastro da mesma pessoa.
--
-- O checkout da Drinfy manda metadata.user_id para a Stripe. Quando a venda chega sem UTM
-- (a pessoa clicou no anúncio no navegador do Instagram e pagou no Safari/Chrome, sem os
-- cookies do clique), procuramos o cadastro dela no rastreamento do app
-- (tracking_events, person_ref ou dedupe_key = id do usuário) e copiamos de lá as UTMs e o
-- fbclid. Assim a venda entra no anúncio certo e a Conversions API recebe o fbc.

alter table public.sales
  add column person_ref text check (char_length(person_ref) <= 200);

comment on column public.sales.person_ref is
  'Quem comprou, no app do cliente (ex.: id do usuário), para a venda herdar o anúncio do cadastro.';

create index sales_person_idx on public.sales (workspace_id, person_ref) where person_ref is not null;

-- Copia UTMs (e fbc a partir do fbclid) do último evento com origem da mesma pessoa.
-- Retorna true quando a venda ganhou origem.
create function private.inherit_sale_origin(p_sale_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale public.sales;
  v_origin public.tracking_events;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found or v_sale.person_ref is null
     or coalesce(v_sale.utm_campaign, v_sale.utm_medium, v_sale.utm_content) is not null then
    return false;
  end if;

  select e.* into v_origin
  from public.tracking_events e
  where e.workspace_id = v_sale.workspace_id
    and coalesce(e.utm_campaign, e.utm_medium, e.utm_content) is not null
    and (e.person_ref = v_sale.person_ref or e.dedupe_key = v_sale.person_ref)
  order by e.occurred_at desc
  limit 1;
  if not found then
    return false;
  end if;

  update public.sales s set
    utm_source = coalesce(s.utm_source, v_origin.utm_source),
    utm_medium = coalesce(s.utm_medium, v_origin.utm_medium),
    utm_campaign = coalesce(s.utm_campaign, v_origin.utm_campaign),
    utm_content = coalesce(s.utm_content, v_origin.utm_content),
    utm_term = coalesce(s.utm_term, v_origin.utm_term),
    fbc = coalesce(
      s.fbc,
      case
        when v_origin.fbclid ~ '^[A-Za-z0-9_-]{8,255}$' and v_origin.touched_at is not null
        then 'fb.1.' || (extract(epoch from v_origin.touched_at) * 1000)::bigint || '.' || v_origin.fbclid
      end
    )
  where s.id = p_sale_id;
  return true;
end;
$$;

revoke all on function private.inherit_sale_origin(uuid) from public;

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
  v_fbc text := nullif(btrim(p_sale ->> 'fbc'), '');
  v_fbp text := nullif(btrim(p_sale ->> 'fbp'), '');
  v_product_id uuid;
  v_previous public.sale_status;
  v_sale_id uuid;
  v_status public.sale_status;
  v_inserted boolean;
  v_attribution public.attribution_status;
  v_trial public.sales;
  v_person text := nullif(left(btrim(p_sale ->> 'person_ref'), 200), '');
begin
  if v_external_order_id is null then
    raise exception 'external_order_id ausente' using errcode = '22023';
  end if;
  -- Formato inválido não derruba a venda: só não vai para a Meta.
  if v_fbc is not null and (char_length(v_fbc) > 500 or v_fbc !~ '^fb\.\d\.\d+\..+$') then
    v_fbc := null;
  end if;
  if v_fbp is not null and (char_length(v_fbp) > 200 or v_fbp !~ '^fb\.\d\.\d+\.\d+$') then
    v_fbp := null;
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
    fbc, fbp, client_user_agent, paid_at, refunded_at, raw_payload, person_ref
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
    v_fbc,
    v_fbp,
    nullif(left(btrim(p_sale ->> 'client_user_agent'), 500), ''),
    (p_sale ->> 'paid_at')::timestamptz,
    (p_sale ->> 'refunded_at')::timestamptz,
    coalesce(p_sale -> 'raw_payload', '{}'::jsonb),
    v_person
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
    fbc = coalesce(excluded.fbc, s.fbc),
    fbp = coalesce(excluded.fbp, s.fbp),
    client_user_agent = coalesce(excluded.client_user_agent, s.client_user_agent),
    paid_at = coalesce(excluded.paid_at, s.paid_at),
    refunded_at = coalesce(excluded.refunded_at, s.refunded_at),
    person_ref = coalesce(excluded.person_ref, s.person_ref)
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

    -- O mesmo para os dados de clique da Meta.
    update public.sales s set
      fbc = coalesce(s.fbc, v_trial.fbc),
      fbp = coalesce(s.fbp, v_trial.fbp),
      client_user_agent = coalesce(s.client_user_agent, v_trial.client_user_agent)
    where s.id = v_sale_id
      and (s.fbc is null or s.fbp is null or s.client_user_agent is null);

    -- Só a primeira cobrança converte; as renovações seguintes não mexem no teste.
    update public.sales s set
      trial_converted_at = coalesce((p_sale ->> 'paid_at')::timestamptz, now()),
      converted_sale_id = v_sale_id
    where s.id = v_trial.id
      and s.converted_sale_id is null;
  end if;

  -- Venda sem UTM herda o anúncio do cadastro da mesma pessoa (rastreamento do app):
  -- quem clica no anúncio no navegador do Instagram e paga em outro navegador chega sem UTM.
  perform private.inherit_sale_origin(v_sale_id);

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

-- Vendas já recebidas: pega o user_id guardado no payload da Stripe e refaz a atribuição.
update public.sales s
set person_ref = left(coalesce(
      s.raw_payload #>> '{data,object,metadata,user_id}',
      s.raw_payload #>> '{data,object,parent,subscription_details,metadata,user_id}',
      s.raw_payload #>> '{data,object,subscription_details,metadata,user_id}'
    ), 200)
where s.person_ref is null
  and coalesce(
      s.raw_payload #>> '{data,object,metadata,user_id}',
      s.raw_payload #>> '{data,object,parent,subscription_details,metadata,user_id}',
      s.raw_payload #>> '{data,object,subscription_details,metadata,user_id}'
    ) is not null;

do $$
declare
  v_sale record;
begin
  for v_sale in
    select s.id from public.sales s
    where s.person_ref is not null
      and coalesce(s.utm_campaign, s.utm_medium, s.utm_content) is null
  loop
    if private.inherit_sale_origin(v_sale.id) then
      perform private.attribute_sale(v_sale.id);
    end if;
  end loop;
end;
$$;
