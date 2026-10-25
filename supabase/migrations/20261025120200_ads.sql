-- Nishiads · Etapa 1 · Contas de anúncio, estrutura (campanha › conjunto › anúncio) e insights diários.
--
-- Cada tabela filha repete workspace_id e o amarra ao pai por chave estrangeira
-- composta (id, workspace_id): um registro nunca aponta para outro tenant.

create table public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  platform public.ad_platform not null default 'meta',
  external_id text not null check (char_length(external_id) between 1 and 64),
  name text not null,
  currency char(3) not null default 'BRL' check (currency ~ '^[A-Z]{3}$'),
  timezone text,
  status public.ad_account_status not null default 'active',
  -- O usuário escolhe quais contas acompanhar depois de conectar.
  is_tracked boolean not null default false,
  -- Id do segredo no Supabase Vault. O token em si nunca sai do banco/Edge Functions.
  token_ref uuid,
  token_expires_at timestamptz,
  last_synced_at timestamptz,
  last_sync_error text,
  backfilled_at timestamptz,
  connected_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, platform, external_id),
  unique (id, workspace_id)
);

create trigger ad_accounts_set_updated_at
before update on public.ad_accounts
for each row execute function private.set_updated_at();

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  ad_account_id uuid not null,
  external_id text not null,
  name text not null,
  status text,
  effective_status text,
  objective text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ad_account_id, external_id),
  unique (id, workspace_id),
  foreign key (ad_account_id, workspace_id)
    references public.ad_accounts (id, workspace_id) on delete cascade
);

create index campaigns_workspace_external_idx on public.campaigns (workspace_id, external_id);
create index campaigns_workspace_name_idx on public.campaigns (workspace_id, name);

create trigger campaigns_set_updated_at
before update on public.campaigns
for each row execute function private.set_updated_at();

create table public.adsets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  ad_account_id uuid not null,
  campaign_id uuid not null,
  external_id text not null,
  name text not null,
  status text,
  effective_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ad_account_id, external_id),
  unique (id, workspace_id),
  foreign key (campaign_id, workspace_id)
    references public.campaigns (id, workspace_id) on delete cascade,
  foreign key (ad_account_id, workspace_id)
    references public.ad_accounts (id, workspace_id) on delete cascade
);

create index adsets_campaign_id_idx on public.adsets (campaign_id);
create index adsets_workspace_external_idx on public.adsets (workspace_id, external_id);
create index adsets_workspace_name_idx on public.adsets (workspace_id, name);

create trigger adsets_set_updated_at
before update on public.adsets
for each row execute function private.set_updated_at();

create table public.ads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  ad_account_id uuid not null,
  campaign_id uuid not null,
  adset_id uuid not null,
  external_id text not null,
  name text not null,
  status text,
  effective_status text,
  creative_id text,
  thumbnail_url text,
  preview_link text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ad_account_id, external_id),
  unique (id, workspace_id),
  foreign key (adset_id, workspace_id)
    references public.adsets (id, workspace_id) on delete cascade,
  foreign key (campaign_id, workspace_id)
    references public.campaigns (id, workspace_id) on delete cascade,
  foreign key (ad_account_id, workspace_id)
    references public.ad_accounts (id, workspace_id) on delete cascade
);

create index ads_adset_id_idx on public.ads (adset_id);
create index ads_campaign_id_idx on public.ads (campaign_id);
create index ads_workspace_external_idx on public.ads (workspace_id, external_id);
create index ads_workspace_name_idx on public.ads (workspace_id, name);

create trigger ads_set_updated_at
before update on public.ads
for each row execute function private.set_updated_at();

-- Uma linha por anúncio por dia (no fuso da conta de anúncio). A sincronização
-- refaz os últimos 3 dias com upsert em (ad_id, date).
create table public.ad_insights_daily (
  ad_id uuid not null,
  date date not null,
  workspace_id uuid not null,
  ad_account_id uuid not null,
  currency char(3) not null default 'BRL',
  spend_cents bigint not null default 0 check (spend_cents >= 0),
  impressions bigint not null default 0 check (impressions >= 0),
  reach bigint not null default 0 check (reach >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  link_clicks bigint not null default 0 check (link_clicks >= 0),
  ctr numeric(12, 6),
  cpc_cents bigint,
  cpm_cents bigint,
  synced_at timestamptz not null default now(),
  primary key (ad_id, date),
  foreign key (ad_id, workspace_id)
    references public.ads (id, workspace_id) on delete cascade,
  foreign key (ad_account_id, workspace_id)
    references public.ad_accounts (id, workspace_id) on delete cascade
);

create index ad_insights_daily_workspace_date_idx on public.ad_insights_daily (workspace_id, date);
create index ad_insights_daily_account_date_idx on public.ad_insights_daily (ad_account_id, date);
