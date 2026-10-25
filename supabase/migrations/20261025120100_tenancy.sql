-- Nishiads · Etapa 1 · Multi-tenant: perfis, workspaces, membros e convites.

-- ---------------------------------------------------------------------------
-- Perfis (espelho mínimo de auth.users, legível pelos colegas de workspace)
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text check (full_name is null or char_length(full_name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Workspaces
-- ---------------------------------------------------------------------------

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  timezone text not null default 'America/Sao_Paulo' check (private.is_valid_timezone(timezone)),
  currency char(3) not null default 'BRL' check (currency ~ '^[A-Z]{3}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger workspaces_set_updated_at
before update on public.workspaces
for each row execute function private.set_updated_at();

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.workspace_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_id_idx on public.workspace_members (user_id);

-- Convites para quem ainda não tem conta. Viram membros quando o e-mail é confirmado.
create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role public.workspace_role not null default 'viewer',
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);

create index workspace_invitations_email_idx on public.workspace_invitations (email);

-- ---------------------------------------------------------------------------
-- Funções de pertencimento usadas pelas policies (security definer para não
-- recursar nas policies de workspace_members).
-- ---------------------------------------------------------------------------

create function private.member_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.workspace_id
  from public.workspace_members m
  where m.user_id = (select auth.uid());
$$;

create function private.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.uid())
  );
$$;

create function private.has_workspace_role(p_workspace_id uuid, p_roles public.workspace_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
  );
$$;

create function private.shares_workspace_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = p_user_id
  );
$$;

-- ---------------------------------------------------------------------------
-- Ciclo de vida do usuário: cria o perfil e aceita convites pendentes
-- somente depois que o e-mail é confirmado (evita sequestro de convite por
-- alguém que se cadastra com o e-mail de outra pessoa).
-- ---------------------------------------------------------------------------

create function private.accept_pending_invitations(p_user_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  select i.workspace_id, p_user_id, i.role
  from public.workspace_invitations i
  where i.email = lower(p_email)
  on conflict (workspace_id, user_id) do nothing;

  delete from public.workspace_invitations i where i.email = lower(p_email);
end;
$$;

create function private.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    lower(coalesce(new.email, '')),
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), '')
  )
  on conflict (id) do update set email = excluded.email;

  if new.email_confirmed_at is not null and new.email is not null then
    perform private.accept_pending_invitations(new.id, new.email);
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_auth_user_change();

create trigger on_auth_user_email_changed
after update of email, email_confirmed_at on auth.users
for each row execute function private.handle_auth_user_change();

-- Usuários que já existiam antes desta migration.
insert into public.profiles (id, email, full_name)
select u.id, lower(coalesce(u.email, '')), nullif(btrim(u.raw_user_meta_data ->> 'full_name'), '')
from auth.users u
on conflict (id) do nothing;

revoke all on all functions in schema private from public;
grant execute on function private.member_workspace_ids() to authenticated, service_role;
grant execute on function private.is_workspace_member(uuid) to authenticated, service_role;
grant execute on function private.has_workspace_role(uuid, public.workspace_role[]) to authenticated, service_role;
grant execute on function private.shares_workspace_with(uuid) to authenticated, service_role;
