-- Nishiads · Etapa 1 · Segredos no Vault e RPCs de workspace.
--
-- Escritas sensíveis (criar workspace, membros, segredos) passam só por estas
-- funções, que conferem o papel de quem chama. As tabelas não têm policy de
-- insert para `authenticated`, então não há outro caminho pela API.

-- ---------------------------------------------------------------------------
-- Vault
-- ---------------------------------------------------------------------------

create function private.store_secret(p_secret text, p_description text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_secret is null or char_length(p_secret) = 0 then
    raise exception 'Segredo vazio.' using errcode = '22023';
  end if;
  return vault.create_secret(p_secret, null, p_description);
end;
$$;

create function private.delete_secret(p_secret_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from vault.secrets where id = p_secret_id;
$$;

-- Apaga o segredo do Vault quando a conta/integração some ou troca de segredo.
create function private.cleanup_secret_ref()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old uuid := to_jsonb(old) ->> tg_argv[0];
  v_new uuid;
begin
  if tg_op = 'UPDATE' then
    v_new := to_jsonb(new) ->> tg_argv[0];
    if v_old is not distinct from v_new then
      return new;
    end if;
  end if;
  if v_old is not null then
    perform private.delete_secret(v_old);
  end if;
  return coalesce(new, old);
end;
$$;

create trigger ad_accounts_cleanup_token
after update of token_ref or delete on public.ad_accounts
for each row execute function private.cleanup_secret_ref('token_ref');

create trigger checkout_integrations_cleanup_secret
after update of webhook_secret_ref or delete on public.checkout_integrations
for each row execute function private.cleanup_secret_ref('webhook_secret_ref');

-- Acesso das Edge Functions (service_role) aos segredos. Nunca expostas a anon/authenticated.
create function public.service_store_secret(p_secret text, p_description text default '')
returns uuid
language sql
security definer
set search_path = ''
as $$
  select private.store_secret(p_secret, p_description);
$$;

create function public.service_read_secret(p_secret_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.id = p_secret_id;
$$;

create function public.service_update_secret(p_secret_id uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform vault.update_secret(p_secret_id, p_secret);
end;
$$;

-- ---------------------------------------------------------------------------
-- Workspaces
-- ---------------------------------------------------------------------------

create function private.require_role(p_workspace_id uuid, p_roles public.workspace_role[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Faça login para continuar.' using errcode = '28000';
  end if;
  if not private.has_workspace_role(p_workspace_id, p_roles) then
    raise exception 'Você não tem permissão para esta ação neste workspace.' using errcode = '42501';
  end if;
end;
$$;

create function public.create_workspace(
  p_name text,
  p_timezone text default 'America/Sao_Paulo',
  p_currency text default 'BRL'
)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_workspace public.workspaces;
begin
  if v_user_id is null then
    raise exception 'Faça login para continuar.' using errcode = '28000';
  end if;

  insert into public.workspaces (name, timezone, currency, created_by)
  values (btrim(p_name), p_timezone, upper(p_currency), v_user_id)
  returning * into v_workspace;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace.id, v_user_id, 'owner');

  return v_workspace;
end;
$$;

-- Adiciona quem já tem conta confirmada; convida quem ainda não tem.
-- Retorna 'added', 'invited' ou 'already_member'.
create function public.invite_workspace_member(
  p_workspace_id uuid,
  p_email text,
  p_role public.workspace_role default 'viewer'
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_user_id uuid;
begin
  perform private.require_role(p_workspace_id, array['owner', 'admin']::public.workspace_role[]);

  if p_role = 'owner' and not private.has_workspace_role(p_workspace_id, array['owner']::public.workspace_role[]) then
    raise exception 'Só um owner pode convidar outro owner.' using errcode = '42501';
  end if;

  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Informe um e-mail válido.' using errcode = '22023';
  end if;

  select u.id into v_user_id
  from auth.users u
  where lower(u.email) = v_email and u.email_confirmed_at is not null;

  if v_user_id is not null then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (p_workspace_id, v_user_id, p_role)
    on conflict (workspace_id, user_id) do nothing;
    return case when found then 'added' else 'already_member' end;
  end if;

  insert into public.workspace_invitations (workspace_id, email, role, invited_by)
  values (p_workspace_id, v_email, p_role, (select auth.uid()))
  on conflict (workspace_id, email)
  do update set role = excluded.role, invited_by = excluded.invited_by, created_at = now();

  return 'invited';
end;
$$;

create function public.update_workspace_member_role(
  p_workspace_id uuid,
  p_user_id uuid,
  p_role public.workspace_role
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.workspace_role;
  v_caller_is_owner boolean;
begin
  perform private.require_role(p_workspace_id, array['owner', 'admin']::public.workspace_role[]);
  v_caller_is_owner := private.has_workspace_role(p_workspace_id, array['owner']::public.workspace_role[]);

  -- Serializa mudanças de membros do workspace (protege a regra do último owner).
  perform 1 from public.workspaces w where w.id = p_workspace_id for update;

  select m.role into v_current
  from public.workspace_members m
  where m.workspace_id = p_workspace_id and m.user_id = p_user_id;

  if v_current is null then
    raise exception 'Membro não encontrado.' using errcode = 'P0002';
  end if;

  if (v_current = 'owner' or p_role = 'owner') and not v_caller_is_owner then
    raise exception 'Só um owner pode alterar o papel de owner.' using errcode = '42501';
  end if;

  if v_current = 'owner' and p_role <> 'owner' and (
    select count(*) from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.role = 'owner'
  ) = 1 then
    raise exception 'O workspace precisa de pelo menos um owner.' using errcode = '23514';
  end if;

  update public.workspace_members m
  set role = p_role
  where m.workspace_id = p_workspace_id and m.user_id = p_user_id;
end;
$$;

-- Remove um membro (admin/owner) ou sai do workspace (qualquer membro, p_user_id = você).
create function public.remove_workspace_member(p_workspace_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_target public.workspace_role;
begin
  if v_caller is null then
    raise exception 'Faça login para continuar.' using errcode = '28000';
  end if;

  if p_user_id <> v_caller then
    perform private.require_role(p_workspace_id, array['owner', 'admin']::public.workspace_role[]);
  elsif not private.is_workspace_member(p_workspace_id) then
    raise exception 'Você não faz parte deste workspace.' using errcode = '42501';
  end if;

  perform 1 from public.workspaces w where w.id = p_workspace_id for update;

  select m.role into v_target
  from public.workspace_members m
  where m.workspace_id = p_workspace_id and m.user_id = p_user_id;

  if v_target is null then
    raise exception 'Membro não encontrado.' using errcode = 'P0002';
  end if;

  if v_target = 'owner' and p_user_id <> v_caller
     and not private.has_workspace_role(p_workspace_id, array['owner']::public.workspace_role[]) then
    raise exception 'Só um owner pode remover outro owner.' using errcode = '42501';
  end if;

  if v_target = 'owner' and (
    select count(*) from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.role = 'owner'
  ) = 1 then
    raise exception 'O workspace precisa de pelo menos um owner. Promova outra pessoa antes de sair.'
      using errcode = '23514';
  end if;

  delete from public.workspace_members m
  where m.workspace_id = p_workspace_id and m.user_id = p_user_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Integrações de checkout (o segredo vai direto para o Vault)
-- ---------------------------------------------------------------------------

create function public.create_checkout_integration(
  p_workspace_id uuid,
  p_provider public.checkout_provider,
  p_name text,
  p_webhook_secret text default null
)
returns public.checkout_integrations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_integration public.checkout_integrations;
  v_secret_ref uuid;
begin
  perform private.require_role(p_workspace_id, array['owner', 'admin']::public.workspace_role[]);

  if p_webhook_secret is not null and char_length(btrim(p_webhook_secret)) > 0 then
    if char_length(btrim(p_webhook_secret)) < 8 then
      raise exception 'O segredo do webhook precisa ter pelo menos 8 caracteres.' using errcode = '22023';
    end if;
    v_secret_ref := private.store_secret(btrim(p_webhook_secret), 'webhook:' || p_provider::text);
  end if;

  insert into public.checkout_integrations (workspace_id, provider, name, webhook_secret_ref, created_by)
  values (p_workspace_id, p_provider, btrim(p_name), v_secret_ref, (select auth.uid()))
  returning * into v_integration;

  return v_integration;
end;
$$;

create function public.set_checkout_integration_secret(p_integration_id uuid, p_webhook_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select c.workspace_id into v_workspace_id
  from public.checkout_integrations c
  where c.id = p_integration_id;

  if v_workspace_id is null then
    raise exception 'Integração não encontrada.' using errcode = 'P0002';
  end if;

  perform private.require_role(v_workspace_id, array['owner', 'admin']::public.workspace_role[]);

  if p_webhook_secret is null or char_length(btrim(p_webhook_secret)) < 8 then
    raise exception 'O segredo do webhook precisa ter pelo menos 8 caracteres.' using errcode = '22023';
  end if;

  -- O trigger cleanup_secret_ref apaga o segredo anterior.
  update public.checkout_integrations c
  set webhook_secret_ref = private.store_secret(btrim(p_webhook_secret), 'webhook:' || c.provider::text)
  where c.id = p_integration_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permissões das funções
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public;
grant execute on function private.member_workspace_ids() to authenticated, service_role;
grant execute on function private.is_workspace_member(uuid) to authenticated, service_role;
grant execute on function private.has_workspace_role(uuid, public.workspace_role[]) to authenticated, service_role;
grant execute on function private.shares_workspace_with(uuid) to authenticated, service_role;
grant execute on function private.is_valid_timezone(text) to authenticated, service_role;

revoke all on function public.service_store_secret(text, text) from public, anon, authenticated;
revoke all on function public.service_read_secret(uuid) from public, anon, authenticated;
revoke all on function public.service_update_secret(uuid, text) from public, anon, authenticated;
grant execute on function public.service_store_secret(text, text) to service_role;
grant execute on function public.service_read_secret(uuid) to service_role;
grant execute on function public.service_update_secret(uuid, text) to service_role;

revoke all on function public.create_workspace(text, text, text) from public, anon;
revoke all on function public.invite_workspace_member(uuid, text, public.workspace_role) from public, anon;
revoke all on function public.update_workspace_member_role(uuid, uuid, public.workspace_role) from public, anon;
revoke all on function public.remove_workspace_member(uuid, uuid) from public, anon;
revoke all on function public.create_checkout_integration(uuid, public.checkout_provider, text, text) from public, anon;
revoke all on function public.set_checkout_integration_secret(uuid, text) from public, anon;
grant execute on function public.create_workspace(text, text, text) to authenticated;
grant execute on function public.invite_workspace_member(uuid, text, public.workspace_role) to authenticated;
grant execute on function public.update_workspace_member_role(uuid, uuid, public.workspace_role) to authenticated;
grant execute on function public.remove_workspace_member(uuid, uuid) to authenticated;
grant execute on function public.create_checkout_integration(uuid, public.checkout_provider, text, text) to authenticated;
grant execute on function public.set_checkout_integration_secret(uuid, text) to authenticated;
