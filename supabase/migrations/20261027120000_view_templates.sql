-- Nishiads · Templates de visualização.
--
-- Cada usuário monta os seus templates: quais métricas aparecem no Dashboard e
-- quais colunas aparecem na tabela de Campanhas (Campanha › Conjunto › Anúncio),
-- e em que ordem. Os templates são pessoais: ninguém do workspace vê os de outro.
--
-- page   dashboard | campaigns
-- items  chaves das métricas/colunas na ordem em que aparecem; o app ignora as
--        chaves que não conhece (uma métrica removida não quebra o template).
-- is_default  o template que abre ao entrar na tela; no máximo um por usuário,
--             workspace e tela. Sem nenhum, o app usa o padrão com tudo.

create table public.view_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  page text not null check (page in ('dashboard', 'campaigns')),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  items text[] not null check (cardinality(items) between 1 and 60),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index view_templates_owner_idx on public.view_templates (user_id, workspace_id, page);
create unique index view_templates_one_default_idx
  on public.view_templates (user_id, workspace_id, page) where is_default;

create trigger view_templates_set_updated_at
before update on public.view_templates
for each row execute function private.set_updated_at();

-- Marcar um template como padrão desmarca o anterior da mesma tela.
create function private.view_templates_single_default()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_default then
    update public.view_templates t
    set is_default = false
    where t.user_id = new.user_id
      and t.workspace_id = new.workspace_id
      and t.page = new.page
      and t.is_default
      and t.id <> new.id;
  end if;
  return new;
end;
$$;

create trigger view_templates_single_default
before insert or update of is_default on public.view_templates
for each row when (new.is_default) execute function private.view_templates_single_default();

-- Limite de templates por usuário, workspace e tela.
create function private.view_templates_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    select count(*) from public.view_templates t
    where t.user_id = new.user_id and t.workspace_id = new.workspace_id and t.page = new.page
  ) >= 20 then
    raise exception 'Limite de 20 templates por tela.' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger view_templates_limit
before insert on public.view_templates
for each row execute function private.view_templates_limit();

revoke all on function private.view_templates_limit() from public;
revoke all on function private.view_templates_single_default() from public;

-- ---------------------------------------------------------------------------
-- RLS: cada um lê e mexe só nos próprios templates, nos workspaces em que é membro.
-- ---------------------------------------------------------------------------

alter table public.view_templates enable row level security;
revoke all on public.view_templates from anon, authenticated;
grant select, delete on public.view_templates to authenticated;
grant insert (workspace_id, page, name, items, is_default) on public.view_templates to authenticated;
grant update (name, items, is_default) on public.view_templates to authenticated;
grant all on public.view_templates to service_role;

create policy "view_templates: dono lê"
on public.view_templates for select to authenticated
using (
  user_id = (select auth.uid())
  and workspace_id in (select private.member_workspace_ids())
);

create policy "view_templates: dono cria"
on public.view_templates for insert to authenticated
with check (
  user_id = (select auth.uid())
  and workspace_id in (select private.member_workspace_ids())
);

create policy "view_templates: dono edita"
on public.view_templates for update to authenticated
using (
  user_id = (select auth.uid())
  and workspace_id in (select private.member_workspace_ids())
)
with check (user_id = (select auth.uid()));

create policy "view_templates: dono apaga"
on public.view_templates for delete to authenticated
using (user_id = (select auth.uid()));
