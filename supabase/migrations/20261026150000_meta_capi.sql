-- Nishiads · Conversions API da Meta (envio das vendas para o pixel/conjunto de dados).
--
-- Cada workspace configura um pixel (id do conjunto de dados) e um token de acesso da
-- Conversions API, guardado no Vault. Um trigger em `sales` põe na fila
-- (meta_capi_events) um evento por venda:
--   aprovada               → Purchase   (inclui renovações e o teste que converteu)
--   teste iniciado         → StartTrial (opcional)
--   reembolso/chargeback   → cancela o Purchase ainda não enviado; se já foi enviado,
--                            manda o evento personalizado Refund (opcional)
-- A Edge Function `meta-capi` envia a fila: logo depois do webhook e, para as
-- retentativas, pelo pg_cron a cada 5 minutos. O event_id é o id do pedido no
-- checkout, então a Meta deduplica reenvios e o mesmo evento vindo do pixel do site.
--
-- Rode este arquivo inteiro de uma vez no SQL Editor.

-- ---------------------------------------------------------------------------
-- Dados de clique na venda (para a Meta casar a venda com quem clicou no anúncio)
-- ---------------------------------------------------------------------------

alter table public.sales
  add column fbc text check (fbc is null or (char_length(fbc) <= 500 and fbc ~ '^fb\.\d\.\d+\..+$')),
  add column fbp text check (fbp is null or (char_length(fbp) <= 200 and fbp ~ '^fb\.\d\.\d+\.\d+$')),
  add column client_user_agent text check (client_user_agent is null or char_length(client_user_agent) <= 500);

comment on column public.sales.fbc is 'Cookie _fbc (ou montado do fbclid) enviado pelo checkout. Vai para a Conversions API.';
comment on column public.sales.fbp is 'Cookie _fbp enviado pelo checkout. Vai para a Conversions API.';
comment on column public.sales.client_user_agent is 'User agent do navegador do comprador, se o checkout enviar.';

-- ---------------------------------------------------------------------------
-- Configuração por workspace
-- ---------------------------------------------------------------------------

create table public.meta_capi_configs (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  pixel_id text not null check (pixel_id ~ '^[0-9]{5,25}$'),
  -- Token da Conversions API no Vault. Ninguém lê pelo app (sem grant na coluna).
  token_ref uuid,
  has_token boolean generated always as (token_ref is not null) stored,
  -- URL do site onde a venda acontece (event_source_url, obrigatório para eventos de site).
  event_source_url text not null check (event_source_url ~ '^https?://[^\s]+$' and char_length(event_source_url) <= 500),
  -- Com código de teste, os eventos aparecem em Gerenciador de Eventos › Testar eventos.
  test_event_code text check (test_event_code is null or test_event_code ~ '^[A-Za-z0-9]{4,40}$'),
  enabled boolean not null default true,
  send_trials boolean not null default true,
  send_refunds boolean not null default false,
  last_sent_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger meta_capi_configs_set_updated_at
before update on public.meta_capi_configs
for each row execute function private.set_updated_at();

create trigger meta_capi_configs_cleanup_token
after update of token_ref or delete on public.meta_capi_configs
for each row execute function private.cleanup_secret_ref('token_ref');

-- ---------------------------------------------------------------------------
-- Fila e log dos eventos enviados
-- ---------------------------------------------------------------------------

create type public.meta_capi_event_status as enum ('pending', 'sent', 'failed', 'skipped');

create table public.meta_capi_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Nulo só no evento de teste do botão "Enviar evento de teste".
  sale_id uuid,
  event_name text not null check (event_name in ('Purchase', 'StartTrial', 'Refund')),
  -- Chave de deduplicação na Meta (junto com event_name).
  event_id text not null check (char_length(event_id) between 1 and 200),
  event_time timestamptz not null,
  is_test boolean not null default false,
  status public.meta_capi_event_status not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  -- O que foi enviado (só dados com hash) e a resposta da Meta, para os logs.
  request jsonb,
  response jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, sale_id, event_name),
  foreign key (sale_id, workspace_id) references public.sales (id, workspace_id) on delete cascade
);

create index meta_capi_events_due_idx on public.meta_capi_events (next_attempt_at) where status = 'pending';
create index meta_capi_events_workspace_idx on public.meta_capi_events (workspace_id, created_at desc);
create index meta_capi_events_sale_idx on public.meta_capi_events (sale_id) where sale_id is not null;

create trigger meta_capi_events_set_updated_at
before update on public.meta_capi_events
for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.meta_capi_configs enable row level security;
alter table public.meta_capi_events enable row level security;

revoke all on public.meta_capi_configs from anon, authenticated;
revoke all on public.meta_capi_events from anon, authenticated;
-- token_ref fica de fora: o app só sabe se existe token (has_token).
grant select (
  workspace_id, pixel_id, has_token, event_source_url, test_event_code, enabled, send_trials,
  send_refunds, last_sent_at, last_error, last_error_at, updated_by, created_at, updated_at
) on public.meta_capi_configs to authenticated;
grant select on public.meta_capi_events to authenticated;
grant all on public.meta_capi_configs to service_role;
grant all on public.meta_capi_events to service_role;

create policy "meta_capi_configs: membros leem"
on public.meta_capi_configs for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

create policy "meta_capi_events: owner e admin leem"
on public.meta_capi_events for select to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- ---------------------------------------------------------------------------
-- Fila: o trigger de vendas
-- ---------------------------------------------------------------------------

create function private.enqueue_meta_capi_event(
  p_workspace_id uuid,
  p_sale_id uuid,
  p_event_name text,
  p_event_id text,
  p_event_time timestamptz
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.meta_capi_events (workspace_id, sale_id, event_name, event_id, event_time)
  values (p_workspace_id, p_sale_id, p_event_name, p_event_id, least(coalesce(p_event_time, now()), now()))
  on conflict (workspace_id, sale_id, event_name) do nothing;
$$;

create function private.sales_meta_capi_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_config public.meta_capi_configs;
  v_old text := case when tg_op = 'UPDATE' then old.status::text end;
  v_new text := new.status::text;
begin
  -- Reembolso antes do envio: o Purchase não vai mais (vale mesmo com o envio pausado).
  if v_new in ('refunded', 'chargeback') and coalesce(v_old, '') not in ('refunded', 'chargeback') then
    update public.meta_capi_events e
    set status = 'skipped', last_error = 'Venda reembolsada antes do envio.', locked_until = null
    where e.sale_id = new.id and e.event_name = 'Purchase' and e.status in ('pending', 'failed');
  end if;

  select * into v_config
  from public.meta_capi_configs c
  where c.workspace_id = new.workspace_id and c.enabled;
  if not found then
    return null;
  end if;

  if v_new = 'approved' and v_old is distinct from 'approved' then
    perform private.enqueue_meta_capi_event(new.workspace_id, new.id, 'Purchase', new.external_order_id, new.paid_at);
  elsif v_new = 'trialing' and tg_op = 'INSERT' and v_config.send_trials then
    perform private.enqueue_meta_capi_event(new.workspace_id, new.id, 'StartTrial', new.external_order_id, new.created_at);
  elsif v_new in ('refunded', 'chargeback') and v_old = 'approved' and v_config.send_refunds
        and exists (
          select 1 from public.meta_capi_events e
          where e.sale_id = new.id and e.event_name = 'Purchase' and e.status = 'sent' and not e.is_test
        ) then
    perform private.enqueue_meta_capi_event(new.workspace_id, new.id, 'Refund', new.external_order_id, new.refunded_at);
  end if;
  return null;
end;
$$;

create trigger sales_meta_capi
after insert or update of status on public.sales
for each row execute function private.sales_meta_capi_trigger();

-- ---------------------------------------------------------------------------
-- RPCs do app (owner/admin)
-- ---------------------------------------------------------------------------

-- Cria ou altera a configuração. p_access_token nulo ou vazio mantém o token atual.
create function public.save_meta_capi_config(
  p_workspace_id uuid,
  p_pixel_id text,
  p_event_source_url text,
  p_access_token text default null,
  p_test_event_code text default null,
  p_enabled boolean default true,
  p_send_trials boolean default true,
  p_send_refunds boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pixel text := btrim(coalesce(p_pixel_id, ''));
  v_url text := btrim(coalesce(p_event_source_url, ''));
  v_token text := nullif(btrim(coalesce(p_access_token, '')), '');
  v_code text := nullif(btrim(coalesce(p_test_event_code, '')), '');
  v_secret uuid;
  v_exists boolean;
begin
  perform private.require_role(p_workspace_id, array['owner', 'admin']::public.workspace_role[]);

  if v_pixel !~ '^[0-9]{5,25}$' then
    raise exception 'O ID do pixel tem só números (ex.: 1234567890123456).' using errcode = '22023';
  end if;
  if v_url !~ '^https?://[^\s]+$' or char_length(v_url) > 500 then
    raise exception 'Informe a URL do site, começando com https://.' using errcode = '22023';
  end if;
  if v_code is not null and v_code !~ '^[A-Za-z0-9]{4,40}$' then
    raise exception 'O código de teste tem só letras e números (ex.: TEST12345).' using errcode = '22023';
  end if;
  if v_token is not null and (char_length(v_token) < 50 or char_length(v_token) > 1000 or v_token ~ '\s') then
    raise exception 'O token parece incompleto. Copie de novo o token gerado no Gerenciador de Eventos.' using errcode = '22023';
  end if;

  select true into v_exists from public.meta_capi_configs c where c.workspace_id = p_workspace_id for update;
  if v_exists is null and v_token is null then
    raise exception 'Cole o token de acesso da Conversions API.' using errcode = '22023';
  end if;
  if v_token is not null then
    v_secret := private.store_secret(v_token, 'meta-capi:' || v_pixel);
  end if;

  -- O trigger cleanup_secret_ref apaga o token anterior quando muda.
  insert into public.meta_capi_configs as c (
    workspace_id, pixel_id, token_ref, event_source_url, test_event_code, enabled,
    send_trials, send_refunds, updated_by
  )
  values (
    p_workspace_id, v_pixel, v_secret, v_url, v_code, coalesce(p_enabled, true),
    coalesce(p_send_trials, true), coalesce(p_send_refunds, false), (select auth.uid())
  )
  on conflict (workspace_id) do update set
    pixel_id = excluded.pixel_id,
    token_ref = coalesce(excluded.token_ref, c.token_ref),
    event_source_url = excluded.event_source_url,
    test_event_code = excluded.test_event_code,
    enabled = excluded.enabled,
    send_trials = excluded.send_trials,
    send_refunds = excluded.send_refunds,
    updated_by = excluded.updated_by,
    last_error = case when excluded.token_ref is not null or excluded.pixel_id <> c.pixel_id then null else c.last_error end,
    last_error_at = case when excluded.token_ref is not null or excluded.pixel_id <> c.pixel_id then null else c.last_error_at end;

  -- Configuração nova (token, pixel): o que estava esperando tenta de novo já.
  update public.meta_capi_events e
  set next_attempt_at = now()
  where e.workspace_id = p_workspace_id and e.status = 'pending' and e.next_attempt_at > now();
end;
$$;

-- Desconecta: apaga o token. Os eventos que ainda não foram não vão mais.
create function public.delete_meta_capi_config(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_role(p_workspace_id, array['owner', 'admin']::public.workspace_role[]);
  update public.meta_capi_events e
  set status = 'skipped', last_error = 'Conversions API desconectada.', locked_until = null
  where e.workspace_id = p_workspace_id and e.status = 'pending';
  delete from public.meta_capi_configs c where c.workspace_id = p_workspace_id;
end;
$$;

-- Põe na fila as vendas dos últimos 7 dias (limite da Meta) que ainda não foram.
-- Usado ao ligar a integração. Retorna quantos eventos entraram.
create function public.enqueue_meta_capi_backfill(p_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_config public.meta_capi_configs;
  v_count integer := 0;
  v_rows integer;
begin
  perform private.require_role(p_workspace_id, array['owner', 'admin']::public.workspace_role[]);
  select * into v_config from public.meta_capi_configs c where c.workspace_id = p_workspace_id;
  if not found or not v_config.enabled then
    raise exception 'Ative a Conversions API antes de enviar as vendas.' using errcode = '22023';
  end if;

  -- Margem de 1 hora para não passar dos 7 dias até o envio.
  insert into public.meta_capi_events (workspace_id, sale_id, event_name, event_id, event_time)
  select s.workspace_id, s.id, 'Purchase', s.external_order_id, s.paid_at
  from public.sales s
  where s.workspace_id = p_workspace_id
    and s.status = 'approved'
    and s.paid_at > now() - interval '7 days' + interval '1 hour'
    and s.paid_at <= now()
  on conflict (workspace_id, sale_id, event_name) do nothing;
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  if v_config.send_trials then
    insert into public.meta_capi_events (workspace_id, sale_id, event_name, event_id, event_time)
    select s.workspace_id, s.id, 'StartTrial', s.external_order_id, s.created_at
    from public.sales s
    where s.workspace_id = p_workspace_id
      and s.status::text = 'trialing'
      and s.created_at > now() - interval '7 days' + interval '1 hour'
    on conflict (workspace_id, sale_id, event_name) do nothing;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end if;

  return v_count;
end;
$$;

-- Botão "Tentar de novo" num evento que falhou.
create function public.retry_meta_capi_event(p_event_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select e.workspace_id into v_workspace_id from public.meta_capi_events e where e.id = p_event_id;
  if v_workspace_id is null then
    raise exception 'Evento não encontrado.' using errcode = 'P0002';
  end if;
  perform private.require_role(v_workspace_id, array['owner', 'admin']::public.workspace_role[]);
  update public.meta_capi_events e
  set status = 'pending', next_attempt_at = now(), locked_until = null
  where e.id = p_event_id and e.status in ('pending', 'failed') and not e.is_test;
  if not found then
    raise exception 'Só eventos com falha podem ser reenviados.' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPCs da Edge Function (service_role)
-- ---------------------------------------------------------------------------

-- Reserva eventos vencidos por 2 minutos (uma execução por evento). Só de
-- workspaces com a integração ligada e com token.
create function public.service_claim_meta_capi_events(
  p_limit integer default 50,
  p_sale_id uuid default null,
  p_event_id bigint default null,
  p_workspace_id uuid default null
)
returns setof public.meta_capi_events
language sql
security definer
set search_path = ''
as $$
  with due as (
    select e.id
    from public.meta_capi_events e
    join public.meta_capi_configs c on c.workspace_id = e.workspace_id and c.enabled and c.token_ref is not null
    where e.status = 'pending'
      and e.next_attempt_at <= now()
      and (e.locked_until is null or e.locked_until < now())
      and (p_sale_id is null or e.sale_id = p_sale_id)
      and (p_event_id is null or e.id = p_event_id)
      and (p_workspace_id is null or e.workspace_id = p_workspace_id)
    order by e.next_attempt_at
    limit greatest(1, least(coalesce(p_limit, 50), 500))
    for update of e skip locked
  )
  update public.meta_capi_events e
  set locked_until = now() + interval '2 minutes'
  from due
  where e.id = due.id
  returning e.*;
$$;

-- Configuração com o token, para a Edge Function.
create function public.service_meta_capi_credentials(p_workspace_id uuid)
returns table (pixel_id text, access_token text, event_source_url text, test_event_code text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.pixel_id, s.decrypted_secret, c.event_source_url, c.test_event_code
  from public.meta_capi_configs c
  join vault.decrypted_secrets s on s.id = c.token_ref
  where c.workspace_id = p_workspace_id;
$$;

-- Agenda o envio da fila a cada 5 minutos (usa o mesmo segredo do cron da Meta).
--   select private.schedule_meta_capi('https://<ref>.supabase.co');
create function private.schedule_meta_capi(p_project_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_project_url !~ '^https://[a-z0-9-]+\.supabase\.co$' then
    raise exception 'Informe a URL do projeto, ex.: https://abcd.supabase.co' using errcode = '22023';
  end if;
  if not exists (select 1 from vault.secrets where name = 'nishiads_cron_secret') then
    perform vault.create_secret(private.random_token(), 'nishiads_cron_secret', 'pg_cron → Edge Functions');
  end if;
  perform cron.schedule(
    'nishiads-meta-capi',
    '*/5 * * * *',
    format(
      $cmd$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'nishiads_cron_secret')
        ),
        body := '{"source":"cron"}'::jsonb,
        timeout_milliseconds := 10000
      );
      $cmd$,
      p_project_url || '/functions/v1/meta-capi'
    )
  );
end;
$$;

-- Se a sincronização da Meta já está agendada, agenda o envio com a mesma URL.
do $$
declare
  v_url text;
begin
  if to_regclass('cron.job') is null then
    return;
  end if;
  execute $q$
    select substring(command from '(https://[a-z0-9-]+\.supabase\.co)/functions/v1/meta-sync')
    from cron.job where jobname = 'nishiads-meta-sync' limit 1
  $q$ into v_url;
  if v_url is not null then
    perform private.schedule_meta_capi(v_url);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Ingestão: guarda fbc, fbp e user agent (e o teste repassa à venda que converte)
-- ---------------------------------------------------------------------------

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
    fbc, fbp, client_user_agent, paid_at, refunded_at, raw_payload
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
    fbc = coalesce(excluded.fbc, s.fbc),
    fbp = coalesce(excluded.fbp, s.fbp),
    client_user_agent = coalesce(excluded.client_user_agent, s.client_user_agent),
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

-- ---------------------------------------------------------------------------
-- Permissões das funções
-- ---------------------------------------------------------------------------

revoke all on function private.enqueue_meta_capi_event(uuid, uuid, text, text, timestamptz) from public;
revoke all on function private.sales_meta_capi_trigger() from public;
revoke all on function private.schedule_meta_capi(text) from public;

revoke all on function public.save_meta_capi_config(uuid, text, text, text, text, boolean, boolean, boolean) from public, anon;
revoke all on function public.delete_meta_capi_config(uuid) from public, anon;
revoke all on function public.enqueue_meta_capi_backfill(uuid) from public, anon;
revoke all on function public.retry_meta_capi_event(bigint) from public, anon;
grant execute on function public.save_meta_capi_config(uuid, text, text, text, text, boolean, boolean, boolean) to authenticated;
grant execute on function public.delete_meta_capi_config(uuid) to authenticated;
grant execute on function public.enqueue_meta_capi_backfill(uuid) to authenticated;
grant execute on function public.retry_meta_capi_event(bigint) to authenticated;

revoke all on function public.service_claim_meta_capi_events(integer, uuid, bigint, uuid) from public, anon, authenticated;
revoke all on function public.service_meta_capi_credentials(uuid) from public, anon, authenticated;
grant execute on function public.service_claim_meta_capi_events(integer, uuid, bigint, uuid) to service_role;
grant execute on function public.service_meta_capi_credentials(uuid) to service_role;

revoke all on function public.service_ingest_sale(uuid, uuid, public.checkout_provider, jsonb) from public, anon, authenticated;
grant execute on function public.service_ingest_sale(uuid, uuid, public.checkout_provider, jsonb) to service_role;
