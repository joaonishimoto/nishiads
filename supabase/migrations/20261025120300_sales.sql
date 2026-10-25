-- Nishiads · Etapa 1 · Integrações de checkout, produtos, vendas e log de webhooks.

create table public.checkout_integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider public.checkout_provider not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- Id do segredo no Supabase Vault (hottok, whsec_..., token da Kiwify).
  webhook_secret_ref uuid,
  -- Parte secreta da URL: /webhooks/{provider}/{webhook_url_token}.
  webhook_url_token text not null unique default private.random_token(),
  active boolean not null default true,
  last_event_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);

create trigger checkout_integrations_set_updated_at
before update on public.checkout_integrations
for each row execute function private.set_updated_at();

-- Custos e taxas por produto, para o cálculo de lucro.
create table public.products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider public.checkout_provider,
  external_product_id text,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  cost_cents bigint not null default 0 check (cost_cents >= 0),
  -- Taxa percentual em pontos-base (1% = 100).
  fee_percent_bps integer not null default 0 check (fee_percent_bps between 0 and 10000),
  fee_fixed_cents bigint not null default 0 check (fee_fixed_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (workspace_id, provider, external_product_id),
  unique (id, workspace_id)
);

create trigger products_set_updated_at
before update on public.products
for each row execute function private.set_updated_at();

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  checkout_integration_id uuid,
  provider public.checkout_provider not null,
  external_order_id text not null check (char_length(external_order_id) between 1 and 200),
  status public.sale_status not null,
  gross_amount_cents bigint not null check (gross_amount_cents >= 0),
  net_amount_cents bigint check (net_amount_cents >= 0),
  currency char(3) not null default 'BRL' check (currency ~ '^[A-Z]{3}$'),
  product_id uuid,
  external_product_id text,
  product_name text,
  -- LGPD: só o hash SHA-256 (hex) do e-mail normalizado; nunca o e-mail em claro.
  customer_email_hash text check (customer_email_hash is null or customer_email_hash ~ '^[0-9a-f]{64}$'),
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  campaign_id uuid,
  adset_id uuid,
  ad_id uuid,
  attribution_status public.attribution_status not null default 'unattributed',
  paid_at timestamptz,
  refunded_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Idempotência: o mesmo pedido do mesmo provedor é atualizado, nunca duplicado.
  -- workspace_id entra na chave para que um tenant nunca bloqueie o pedido de outro.
  unique (workspace_id, provider, external_order_id),
  foreign key (checkout_integration_id, workspace_id)
    references public.checkout_integrations (id, workspace_id) on delete set null (checkout_integration_id),
  foreign key (product_id, workspace_id)
    references public.products (id, workspace_id) on delete set null (product_id),
  foreign key (campaign_id, workspace_id)
    references public.campaigns (id, workspace_id) on delete set null (campaign_id),
  foreign key (adset_id, workspace_id)
    references public.adsets (id, workspace_id) on delete set null (adset_id),
  foreign key (ad_id, workspace_id)
    references public.ads (id, workspace_id) on delete set null (ad_id)
);

-- Índices do dashboard.
create index sales_workspace_paid_at_idx on public.sales (workspace_id, paid_at desc);
create index sales_ad_id_idx on public.sales (ad_id);
create index sales_adset_id_idx on public.sales (adset_id);
create index sales_campaign_id_idx on public.sales (campaign_id);
create index sales_unattributed_idx on public.sales (workspace_id, paid_at desc)
  where attribution_status <> 'matched';

create trigger sales_set_updated_at
before update on public.sales
for each row execute function private.set_updated_at();

-- Tudo que chega nos webhooks, para a tela "Logs de integração", auditoria e reprocessamento.
create table public.webhook_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  checkout_integration_id uuid,
  provider public.checkout_provider not null,
  status public.webhook_event_status not null default 'received',
  event_type text,
  external_order_id text,
  sale_id uuid references public.sales (id) on delete set null,
  error text,
  payload jsonb not null,
  attempts integer not null default 0,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  foreign key (checkout_integration_id, workspace_id)
    references public.checkout_integrations (id, workspace_id) on delete set null (checkout_integration_id)
);

create index webhook_events_workspace_received_idx on public.webhook_events (workspace_id, received_at desc);
create index webhook_events_pending_idx on public.webhook_events (received_at)
  where status in ('received', 'failed');

-- Supabase Realtime: a venda aparece no dashboard aberto assim que entra (respeita RLS).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.sales;
  end if;
end
$$;
