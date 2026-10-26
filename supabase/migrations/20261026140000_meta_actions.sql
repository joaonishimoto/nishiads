-- Nishiads · Controle da Meta Ads: pausar, ativar e ajustar orçamento pelo app.
--
-- As escritas na Meta passam pela Edge Function meta-actions (owner/admin) e pelas
-- regras automáticas, sempre com a service_role. Cada tentativa, com sucesso ou não,
-- fica em meta_action_log. O orçamento sincronizado da Meta fica nas próprias
-- campanhas e conjuntos, em centavos da moeda da conta.

alter table public.campaigns
  add column daily_budget_cents bigint check (daily_budget_cents >= 0),
  add column lifetime_budget_cents bigint check (lifetime_budget_cents >= 0);

alter table public.adsets
  add column daily_budget_cents bigint check (daily_budget_cents >= 0),
  add column lifetime_budget_cents bigint check (lifetime_budget_cents >= 0);

comment on column public.campaigns.daily_budget_cents is
  'Orçamento diário da campanha (Advantage+ / CBO). Nulo quando o orçamento fica nos conjuntos.';
comment on column public.adsets.daily_budget_cents is
  'Orçamento diário do conjunto. Nulo quando a campanha usa orçamento de campanha (CBO).';

-- ---------------------------------------------------------------------------
-- Histórico de alterações feitas pelo Nishiads na Meta
-- ---------------------------------------------------------------------------

create table public.meta_action_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  ad_account_id uuid,
  level text not null check (level in ('campaign', 'adset', 'ad')),
  object_id uuid not null,
  external_id text not null,
  object_name text,
  action text not null check (action in ('pause', 'activate', 'set_budget')),
  -- Valores antes e o pedido: { status } ou { daily_budget_cents | lifetime_budget_cents }.
  previous jsonb,
  requested jsonb not null default '{}',
  ok boolean not null,
  error text,
  -- manual (botão no app) ou rule (regras automáticas).
  source text not null default 'manual' check (source in ('manual', 'rule')),
  actor_user_id uuid references public.profiles (id) on delete set null,
  context jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (ad_account_id, workspace_id)
    references public.ad_accounts (id, workspace_id) on delete cascade
);

create index meta_action_log_workspace_created_idx on public.meta_action_log (workspace_id, created_at desc);
create index meta_action_log_object_idx on public.meta_action_log (object_id, created_at desc);
create index meta_action_log_actor_created_idx on public.meta_action_log (actor_user_id, created_at desc);

alter table public.meta_action_log enable row level security;
revoke all on public.meta_action_log from anon, authenticated;
grant select on public.meta_action_log to authenticated;
grant all on public.meta_action_log to service_role;

create policy "meta_action_log: membros leem"
on public.meta_action_log for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));
