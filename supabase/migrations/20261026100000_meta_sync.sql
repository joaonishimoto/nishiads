-- Nishiads · Etapa 4 · Conexão com a Meta Ads e sincronização.
--
-- Um login do Facebook (meta_connections) dá acesso a várias contas de anúncio.
-- O token de longa duração fica no Vault, uma vez por conexão; ad_accounts aponta
-- para a conexão (ad_accounts.token_ref segue vazio para a Meta). As Edge
-- Functions meta-oauth e meta-sync escrevem com a service_role; o app só lê,
-- escolhe as contas acompanhadas (is_tracked) e desconecta.

-- ---------------------------------------------------------------------------
-- Conexões (um usuário do Facebook por workspace)
-- ---------------------------------------------------------------------------

create type public.meta_connection_status as enum ('active', 'needs_reconnect');

create table public.meta_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  meta_user_id text not null check (meta_user_id ~ '^[0-9]{1,32}$'),
  meta_user_name text,
  token_ref uuid,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  status public.meta_connection_status not null default 'active',
  last_error text,
  connected_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, meta_user_id),
  unique (id, workspace_id)
);

create trigger meta_connections_set_updated_at
before update on public.meta_connections
for each row execute function private.set_updated_at();

create trigger meta_connections_cleanup_token
after update of token_ref or delete on public.meta_connections
for each row execute function private.cleanup_secret_ref('token_ref');

alter table public.ad_accounts
  add column meta_connection_id uuid,
  -- Trava da sincronização (uma execução por conta) e pausa por rate limit.
  add column sync_started_at timestamptz,
  add column rate_limited_until timestamptz,
  add constraint ad_accounts_meta_connection_fkey
    foreign key (meta_connection_id, workspace_id)
    references public.meta_connections (id, workspace_id)
    on delete set null (meta_connection_id);

create index ad_accounts_meta_connection_idx on public.ad_accounts (meta_connection_id);
create index ad_accounts_tracked_idx on public.ad_accounts (last_synced_at nulls first) where is_tracked;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.meta_connections enable row level security;
revoke all on public.meta_connections from anon, authenticated;
grant select on public.meta_connections to authenticated;
grant all on public.meta_connections to service_role;

create policy "meta_connections: membros leem"
on public.meta_connections for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

-- ---------------------------------------------------------------------------
-- OAuth: o `state` amarra o retorno do Facebook ao usuário e ao workspace
-- ---------------------------------------------------------------------------

create table private.meta_oauth_states (
  state text primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  return_to text not null,
  expires_at timestamptz not null default now() + interval '15 minutes',
  created_at timestamptz not null default now()
);

create function public.service_create_meta_oauth_state(p_workspace_id uuid, p_user_id uuid, p_return_to text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text := private.random_token();
begin
  if not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = p_user_id and m.role in ('owner', 'admin')
  ) then
    raise exception 'Só owners e admins conectam a Meta.' using errcode = '42501';
  end if;
  delete from private.meta_oauth_states where expires_at < now();
  insert into private.meta_oauth_states (state, workspace_id, user_id, return_to)
  values (v_state, p_workspace_id, p_user_id, p_return_to);
  return v_state;
end;
$$;

-- Uso único: apaga o state ao ler. Não devolve nada se expirou ou não existe.
create function public.service_consume_meta_oauth_state(p_state text)
returns table (workspace_id uuid, user_id uuid, return_to text)
language sql
security definer
set search_path = ''
as $$
  delete from private.meta_oauth_states s
  where s.state = p_state and s.expires_at >= now()
  returning s.workspace_id, s.user_id, s.return_to;
$$;

-- Grava (ou renova) a conexão com o token novo no Vault. O token anterior é
-- apagado pelo trigger cleanup_secret_ref.
create function public.service_upsert_meta_connection(
  p_workspace_id uuid,
  p_user_id uuid,
  p_meta_user_id text,
  p_meta_user_name text,
  p_token text,
  p_token_expires_at timestamptz,
  p_scopes text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_secret uuid := private.store_secret(p_token, 'meta:' || p_meta_user_id);
begin
  insert into public.meta_connections as c (
    workspace_id, meta_user_id, meta_user_name, token_ref, token_expires_at, scopes, status, last_error, connected_by
  )
  values (
    p_workspace_id, p_meta_user_id, p_meta_user_name, v_secret, p_token_expires_at,
    coalesce(p_scopes, '{}'), 'active', null, p_user_id
  )
  on conflict (workspace_id, meta_user_id) do update
  set meta_user_name = excluded.meta_user_name,
      token_ref = excluded.token_ref,
      token_expires_at = excluded.token_expires_at,
      scopes = excluded.scopes,
      status = 'active',
      last_error = null,
      connected_by = excluded.connected_by
  returning c.id into v_id;
  return v_id;
end;
$$;

-- Desconecta: apaga o token. As contas ficam (com o histórico) e pedem reconexão.
create function public.disconnect_meta_connection(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select c.workspace_id into v_workspace_id from public.meta_connections c where c.id = p_connection_id;
  if v_workspace_id is null then
    raise exception 'Conexão não encontrada.' using errcode = 'P0002';
  end if;
  perform private.require_role(v_workspace_id, array['owner', 'admin']::public.workspace_role[]);

  update public.ad_accounts a
  set status = 'needs_reconnect', last_sync_error = 'Conexão com a Meta removida.'
  where a.meta_connection_id = p_connection_id;

  delete from public.meta_connections c where c.id = p_connection_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sincronização
-- ---------------------------------------------------------------------------

-- Reserva a conta para uma execução. Uma trava com mais de 10 min é de uma
-- execução que morreu (limite de tempo da Edge Function) e pode ser retomada.
create function public.service_claim_ad_account_sync(p_ad_account_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ad_accounts a
  set sync_started_at = now()
  where a.id = p_ad_account_id
    and (a.sync_started_at is null or a.sync_started_at < now() - interval '10 minutes');
  return found;
end;
$$;

-- Segredo que o pg_cron manda no header x-cron-secret.
create function public.service_check_cron_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets s
    where s.name = 'nishiads_cron_secret' and s.decrypted_secret = p_secret and char_length(p_secret) >= 32
  );
$$;

-- Agenda a sincronização a cada 15 minutos (pg_cron + pg_net). Rode uma vez por
-- projeto, com a URL do Supabase:
--   select private.schedule_meta_sync('https://<ref>.supabase.co');
create function private.schedule_meta_sync(p_project_url text)
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
    'nishiads-meta-sync',
    '*/15 * * * *',
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
      p_project_url || '/functions/v1/meta-sync'
    )
  );
end;
$$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Permissões das funções
-- ---------------------------------------------------------------------------

revoke all on function private.schedule_meta_sync(text) from public;

revoke all on function public.service_create_meta_oauth_state(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.service_consume_meta_oauth_state(text) from public, anon, authenticated;
revoke all on function public.service_upsert_meta_connection(uuid, uuid, text, text, text, timestamptz, text[]) from public, anon, authenticated;
revoke all on function public.service_claim_ad_account_sync(uuid) from public, anon, authenticated;
revoke all on function public.service_check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.service_create_meta_oauth_state(uuid, uuid, text) to service_role;
grant execute on function public.service_consume_meta_oauth_state(text) to service_role;
grant execute on function public.service_upsert_meta_connection(uuid, uuid, text, text, text, timestamptz, text[]) to service_role;
grant execute on function public.service_claim_ad_account_sync(uuid) to service_role;
grant execute on function public.service_check_cron_secret(text) to service_role;

revoke all on function public.disconnect_meta_connection(uuid) from public, anon;
grant execute on function public.disconnect_meta_connection(uuid) to authenticated;
