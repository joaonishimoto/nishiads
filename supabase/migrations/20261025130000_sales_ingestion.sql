-- Nishiads · Etapa 2 · Ingestão de vendas e atribuição por UTM.
--
-- A Edge Function `webhooks` normaliza o payload de cada provedor e chama
-- service_ingest_sale(), que faz o upsert idempotente e a atribuição numa
-- única transação.
--
-- Atribuição (UTMs no formato "nome|id" gerado pelos parâmetros de URL da Meta):
--   utm_campaign → campanha · utm_medium → conjunto · utm_content → anúncio
-- attribution_status:
--   matched      → o anúncio foi encontrado (campanha e conjunto vêm dele)
--   partial      → há UTMs, mas o anúncio ainda não foi encontrado (ex.: Meta
--                  não sincronizada, nome ambíguo ou só campanha identificada)
--   unattributed → a venda chegou sem UTMs

-- "Campanha X|120200000000001" → (Campanha X, 120200000000001); "120200000000001" → (null, id).
create function private.split_utm_ref(p_value text, out ref_name text, out ref_id text)
language sql
immutable
set search_path = ''
as $$
  select
    case
      when p_value ~ '^\s*\d{6,}\s*$' then null
      else nullif(btrim(regexp_replace(p_value, '\|\s*\d+\s*$', '')), '')
    end,
    coalesce(
      substring(p_value from '\|\s*(\d+)\s*$'),
      substring(p_value from '^\s*(\d{6,})\s*$')
    );
$$;

-- Ordem de status: uma entrega atrasada nunca faz a venda "voltar" (reembolso → aprovado).
create function private.sale_status_rank(p_status public.sale_status)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'pending' then 0
    when 'canceled' then 1
    when 'approved' then 2
    when 'refunded' then 3
    when 'chargeback' then 4
  end;
$$;

create function private.attribute_sale(p_sale_id uuid)
returns public.attribution_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale public.sales;
  v_campaign_ref record;
  v_adset_ref record;
  v_ad_ref record;
  v_campaign_id uuid;
  v_adset_id uuid;
  v_adset_campaign_id uuid;
  v_ad_id uuid;
  v_ad_adset_id uuid;
  v_ad_campaign_id uuid;
  v_status public.attribution_status;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    return null;
  end if;

  select * into v_campaign_ref from private.split_utm_ref(v_sale.utm_campaign);
  select * into v_adset_ref from private.split_utm_ref(v_sale.utm_medium);
  select * into v_ad_ref from private.split_utm_ref(v_sale.utm_content);

  -- Campanha: pelo id; senão pelo nome, só se for único no workspace.
  if v_campaign_ref.ref_id is not null then
    select c.id into v_campaign_id
    from public.campaigns c
    where c.workspace_id = v_sale.workspace_id and c.external_id = v_campaign_ref.ref_id
    limit 1;
  end if;
  if v_campaign_id is null and v_campaign_ref.ref_name is not null then
    select (array_agg(c.id))[1] into v_campaign_id
    from public.campaigns c
    where c.workspace_id = v_sale.workspace_id and lower(c.name) = lower(v_campaign_ref.ref_name)
    having count(*) = 1;
  end if;

  -- Conjunto: pelo id; senão pelo nome dentro da campanha encontrada.
  if v_adset_ref.ref_id is not null then
    select s.id, s.campaign_id into v_adset_id, v_adset_campaign_id
    from public.adsets s
    where s.workspace_id = v_sale.workspace_id and s.external_id = v_adset_ref.ref_id
    limit 1;
  end if;
  if v_adset_id is null and v_adset_ref.ref_name is not null then
    select (array_agg(s.id))[1], (array_agg(s.campaign_id))[1] into v_adset_id, v_adset_campaign_id
    from public.adsets s
    where s.workspace_id = v_sale.workspace_id
      and lower(s.name) = lower(v_adset_ref.ref_name)
      and (v_campaign_id is null or s.campaign_id = v_campaign_id)
    having count(*) = 1;
  end if;

  -- Anúncio: pelo id; senão pelo nome dentro do conjunto/campanha encontrados.
  if v_ad_ref.ref_id is not null then
    select a.id, a.adset_id, a.campaign_id into v_ad_id, v_ad_adset_id, v_ad_campaign_id
    from public.ads a
    where a.workspace_id = v_sale.workspace_id and a.external_id = v_ad_ref.ref_id
    limit 1;
  end if;
  if v_ad_id is null and v_ad_ref.ref_name is not null then
    select (array_agg(a.id))[1], (array_agg(a.adset_id))[1], (array_agg(a.campaign_id))[1]
      into v_ad_id, v_ad_adset_id, v_ad_campaign_id
    from public.ads a
    where a.workspace_id = v_sale.workspace_id
      and lower(a.name) = lower(v_ad_ref.ref_name)
      and (v_adset_id is null or a.adset_id = v_adset_id)
      and (v_campaign_id is null or a.campaign_id = v_campaign_id)
    having count(*) = 1;
  end if;

  -- O nível mais baixo encontrado define os pais (ids da Meta valem mais que nomes).
  if v_ad_id is not null then
    v_adset_id := v_ad_adset_id;
    v_campaign_id := v_ad_campaign_id;
  elsif v_adset_id is not null then
    v_campaign_id := v_adset_campaign_id;
  end if;

  v_status := case
    when v_ad_id is not null then 'matched'
    when coalesce(v_sale.utm_campaign, v_sale.utm_medium, v_sale.utm_content) is not null then 'partial'
    else 'unattributed'
  end;

  update public.sales s
  set campaign_id = v_campaign_id,
      adset_id = v_adset_id,
      ad_id = v_ad_id,
      attribution_status = v_status
  where s.id = p_sale_id
    and (s.campaign_id, s.adset_id, s.ad_id, s.attribution_status)
        is distinct from (v_campaign_id, v_adset_id, v_ad_id, v_status);

  return v_status;
end;
$$;

-- Upsert idempotente de uma venda normalizada. Só a service_role (Edge Functions) chama.
-- p_sale: { external_order_id, status, gross_amount_cents, net_amount_cents, currency,
--           external_product_id, product_name, customer_email_hash, utm_source, utm_medium,
--           utm_campaign, utm_content, utm_term, paid_at, refunded_at, raw_payload }
create function public.service_ingest_sale(
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
  v_product_id uuid;
  v_previous public.sale_status;
  v_sale_id uuid;
  v_status public.sale_status;
  v_inserted boolean;
  v_attribution public.attribution_status;
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

  v_attribution := private.attribute_sale(v_sale_id);

  return jsonb_build_object(
    'sale_id', v_sale_id,
    'status', v_status,
    'previous_status', v_previous,
    'inserted', v_inserted,
    'attribution_status', v_attribution
  );
end;
$$;

-- Refaz a atribuição das vendas ainda não casadas (ex.: depois de sincronizar a Meta).
create function private.reattribute_workspace_sales(p_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale_id uuid;
  v_matched integer := 0;
begin
  for v_sale_id in
    select s.id from public.sales s
    where s.workspace_id = p_workspace_id and s.attribution_status <> 'matched'
  loop
    if private.attribute_sale(v_sale_id) = 'matched' then
      v_matched := v_matched + 1;
    end if;
  end loop;
  return v_matched;
end;
$$;

-- Botão "Refazer atribuição" (owner/admin).
create function public.reattribute_sales(p_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_workspace_id, array['owner', 'admin']::public.workspace_role[]);
  return private.reattribute_workspace_sales(p_workspace_id);
end;
$$;

-- Sincronização da Meta (Edge Function com service_role).
create function public.service_reattribute_sales(p_workspace_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  select private.reattribute_workspace_sales(p_workspace_id);
$$;

revoke all on function private.split_utm_ref(text) from public;
revoke all on function private.sale_status_rank(public.sale_status) from public;
revoke all on function private.attribute_sale(uuid) from public;

revoke all on function public.service_ingest_sale(uuid, uuid, public.checkout_provider, jsonb) from public, anon, authenticated;
grant execute on function public.service_ingest_sale(uuid, uuid, public.checkout_provider, jsonb) to service_role;

revoke all on function private.reattribute_workspace_sales(uuid) from public;
revoke all on function public.reattribute_sales(uuid) from public, anon;
grant execute on function public.reattribute_sales(uuid) to authenticated;
revoke all on function public.service_reattribute_sales(uuid) from public, anon, authenticated;
grant execute on function public.service_reattribute_sales(uuid) to service_role;
