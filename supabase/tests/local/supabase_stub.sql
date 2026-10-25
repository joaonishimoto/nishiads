-- Stub mínimo do ambiente Supabase (roles, auth, vault) para rodar as migrations
-- e os testes de RLS num Postgres puro (CI / máquina sem Docker).
-- NÃO aplique isto num projeto Supabase de verdade.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$;

create schema vault;
revoke all on schema vault from public;

create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  created_at timestamptz not null default now()
);

create view vault.decrypted_secrets as
select id, name, description, secret as decrypted_secret, created_at from vault.secrets;

create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
returns uuid
language sql
as $$
  insert into vault.secrets (secret, name, description)
  values (new_secret, new_name, new_description)
  returning id;
$$;

create function vault.update_secret(secret_id uuid, new_secret text)
returns void
language sql
as $$
  update vault.secrets set secret = new_secret where id = secret_id;
$$;
