-- Nishiads · Etapa 1 · Base: schema privado, tipos e utilitários.
--
-- Convenções do banco:
-- - Todo dado de negócio pertence a um workspace (coluna workspace_id).
-- - Valores monetários em centavos (bigint). Datas em timestamptz (UTC).
-- - Funções de apoio às policies ficam no schema `private`, que não é exposto pela API.

create schema if not exists private;
revoke all on schema private from public;
-- As policies chamam funções de `private` com os privilégios de quem consulta.
grant usage on schema private to authenticated, service_role;

-- Supabase Vault guarda tokens da Meta e segredos de webhook criptografados.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'supabase_vault') then
    create extension if not exists supabase_vault;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------

create type public.workspace_role as enum ('owner', 'admin', 'viewer');

-- Google Ads e TikTok Ads entram depois com `alter type ... add value`.
create type public.ad_platform as enum ('meta');

create type public.ad_account_status as enum ('active', 'needs_reconnect', 'disabled', 'error');

create type public.checkout_provider as enum ('kiwify', 'hotmart', 'stripe', 'eduzz', 'generic');

create type public.sale_status as enum ('approved', 'pending', 'refunded', 'chargeback', 'canceled');

create type public.attribution_status as enum ('matched', 'partial', 'unattributed');

create type public.notification_channel as enum ('webpush', 'telegram');

create type public.webhook_event_status as enum ('received', 'processed', 'ignored', 'rejected', 'failed');

-- ---------------------------------------------------------------------------
-- Utilitários
-- ---------------------------------------------------------------------------

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create function private.is_valid_timezone(p_timezone text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone);
$$;

-- Token aleatório de 64 caracteres hex (256 bits) para URLs de webhook.
create function private.random_token()
returns text
language sql
volatile
set search_path = ''
as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

revoke all on all functions in schema private from public;
