-- Testes de RLS, RPCs e Vault da etapa 1.
-- Rodam dentro de uma transação desfeita no fim: seguros em banco local ou de staging.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql
--
-- Qualquer falha interrompe com uma exceção "FALHOU: ...".

\set ON_ERROR_STOP 1
\o /dev/null
begin;

-- Usuários de teste: Ana (owner), Bruno (viewer), Carla (sem acesso), Davi (convidado sem conta).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'ana@teste.nishiads.dev', now(), '{"full_name":"Ana Teste"}'),
  ('00000000-0000-0000-0000-00000000000b', 'bruno@teste.nishiads.dev', now(), '{"full_name":"Bruno Teste"}'),
  ('00000000-0000-0000-0000-00000000000c', 'carla@teste.nishiads.dev', now(), '{}');

do $$ begin
  if (select count(*) from public.profiles where email like '%@teste.nishiads.dev') <> 3 then
    raise exception 'FALHOU: perfis não foram criados pelo trigger de auth.users';
  end if;
end $$;

-- Toda tabela de public tem RLS e ao menos uma policy.
do $$
declare v record;
begin
  for v in
    select c.relname, c.relrowsecurity,
      (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    if not v.relrowsecurity or v.policies = 0 then
      raise exception 'FALHOU: tabela public.% sem RLS ou sem policy', v.relname;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- Ana cria o workspace
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

select set_config('test.ws', (public.create_workspace('Agência da Ana')).id::text, true);

do $$ begin
  if (select role from public.workspace_members where user_id = auth.uid()) <> 'owner' then
    raise exception 'FALHOU: criador não virou owner';
  end if;
  if (select timezone || '/' || currency from public.workspaces where id = current_setting('test.ws')::uuid)
     <> 'America/Sao_Paulo/BRL' then
    raise exception 'FALHOU: padrões de fuso/moeda';
  end if;
  if not exists (select 1 from public.notification_preferences where user_id = auth.uid()) then
    raise exception 'FALHOU: preferências padrão não criadas';
  end if;
end $$;

-- Inserir direto em workspace_members é bloqueado (só via RPC).
do $$ begin
  begin
    insert into public.workspace_members (workspace_id, user_id, role)
    values (current_setting('test.ws')::uuid, '00000000-0000-0000-0000-00000000000c', 'owner');
    raise exception 'FALHOU: insert direto em workspace_members passou';
  exception when insufficient_privilege then null;
  end;
end $$;

do $$ begin
  if public.invite_workspace_member(current_setting('test.ws')::uuid, 'Bruno@Teste.nishiads.dev', 'viewer') <> 'added' then
    raise exception 'FALHOU: usuário existente deveria ser adicionado direto';
  end if;
  if public.invite_workspace_member(current_setting('test.ws')::uuid, 'davi@teste.nishiads.dev', 'admin') <> 'invited' then
    raise exception 'FALHOU: e-mail sem conta deveria virar convite';
  end if;
end $$;

-- Integração com segredo: o segredo vai para o Vault e não pode ser lido pelo app.
select set_config(
  'test.integration',
  (public.create_checkout_integration(current_setting('test.ws')::uuid, 'hotmart', 'Hotmart principal', 'hottok-super-secreto')).id::text,
  true
);

do $$ begin
  begin
    perform public.service_read_secret(
      (select webhook_secret_ref from public.checkout_integrations where id = current_setting('test.integration')::uuid)
    );
    raise exception 'FALHOU: authenticated conseguiu ler segredo';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from vault.decrypted_secrets;
    raise exception 'FALHOU: authenticated acessou vault.decrypted_secrets';
  exception when insufficient_privilege then null;
  end;
  -- Não dá para apontar a integração para o segredo de outro tenant.
  begin
    update public.checkout_integrations set webhook_secret_ref = gen_random_uuid()
    where id = current_setting('test.integration')::uuid;
    raise exception 'FALHOU: authenticated alterou webhook_secret_ref';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------- dados de anúncio/venda (service_role)
reset role;
set local role service_role;

insert into public.ad_accounts (id, workspace_id, external_id, name, token_ref)
values ('10000000-0000-0000-0000-000000000001', current_setting('test.ws')::uuid, 'act_123', 'Conta Ana',
        public.service_store_secret('EAAB-token-falso', 'meta:act_123'));
insert into public.campaigns (id, workspace_id, ad_account_id, external_id, name)
values ('20000000-0000-0000-0000-000000000001', current_setting('test.ws')::uuid,
        '10000000-0000-0000-0000-000000000001', '120200000000001', 'Campanha X');
insert into public.adsets (id, workspace_id, ad_account_id, campaign_id, external_id, name)
values ('30000000-0000-0000-0000-000000000001', current_setting('test.ws')::uuid,
        '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '120200000000002', 'Conjunto Y');
insert into public.ads (id, workspace_id, ad_account_id, campaign_id, adset_id, external_id, name)
values ('40000000-0000-0000-0000-000000000001', current_setting('test.ws')::uuid,
        '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
        '30000000-0000-0000-0000-000000000001', '120200000000003', 'Criativo Z');
insert into public.ad_insights_daily (ad_id, date, workspace_id, ad_account_id, spend_cents, impressions)
values ('40000000-0000-0000-0000-000000000001', '2026-10-24', current_setting('test.ws')::uuid,
        '10000000-0000-0000-0000-000000000001', 5000, 1200);
insert into public.sales (workspace_id, provider, external_order_id, status, gross_amount_cents, ad_id, attribution_status, paid_at)
values (current_setting('test.ws')::uuid, 'hotmart', 'HP-0001', 'approved', 19700,
        '40000000-0000-0000-0000-000000000001', 'matched', now());

do $$ begin
  -- Idempotência por (workspace, provedor, pedido).
  begin
    insert into public.sales (workspace_id, provider, external_order_id, status, gross_amount_cents)
    values (current_setting('test.ws')::uuid, 'hotmart', 'HP-0001', 'refunded', 19700);
    raise exception 'FALHOU: venda duplicada aceita';
  exception when unique_violation then null;
  end;
  if public.service_read_secret((select token_ref from public.ad_accounts where external_id = 'act_123'))
     <> 'EAAB-token-falso' then
    raise exception 'FALHOU: service_role não leu o token do Vault';
  end if;
end $$;

-- ---------------------------------------------------------------- Bruno (viewer)
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);

do $$ begin
  if (select count(*) from public.sales) <> 1 or (select count(*) from public.ad_insights_daily) <> 1 then
    raise exception 'FALHOU: viewer deveria ver vendas e insights do workspace';
  end if;
  if (select count(*) from public.profiles) <> 2 then
    raise exception 'FALHOU: viewer deveria ver o próprio perfil e o da Ana';
  end if;
  if exists (select 1 from public.workspace_invitations) then
    raise exception 'FALHOU: viewer não deveria ver convites';
  end if;
  if exists (select 1 from public.webhook_events) then
    raise exception 'FALHOU: viewer não deveria ver payloads de webhook';
  end if;

  update public.workspaces set name = 'Hackeado' where id = current_setting('test.ws')::uuid;
  if (select name from public.workspaces where id = current_setting('test.ws')::uuid) <> 'Agência da Ana' then
    raise exception 'FALHOU: viewer renomeou o workspace';
  end if;

  begin
    perform public.invite_workspace_member(current_setting('test.ws')::uuid, 'x@teste.nishiads.dev', 'viewer');
    raise exception 'FALHOU: viewer convidou alguém';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.products (workspace_id, name) values (current_setting('test.ws')::uuid, 'Curso');
    raise exception 'FALHOU: viewer criou produto';
  exception when insufficient_privilege then null;
  end;

  -- Viewer registra o próprio dispositivo para Web Push.
  insert into public.notification_subscriptions (workspace_id, user_id, channel, endpoint, config)
  values (current_setting('test.ws')::uuid, auth.uid(), 'webpush', 'https://push.example.com/abc',
          '{"p256dh":"x","auth":"y"}');

  begin
    insert into public.notification_subscriptions (workspace_id, user_id, channel, endpoint)
    values (current_setting('test.ws')::uuid, '00000000-0000-0000-0000-00000000000a', 'webpush', 'https://push.example.com/zz');
    raise exception 'FALHOU: viewer cadastrou dispositivo para outra pessoa';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------- Carla (outro tenant)
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);

do $$ begin
  if exists (select 1 from public.workspaces) or exists (select 1 from public.sales)
     or exists (select 1 from public.ad_accounts) or exists (select 1 from public.ads)
     or exists (select 1 from public.checkout_integrations) or exists (select 1 from public.workspace_members) then
    raise exception 'FALHOU: Carla enxerga dados de outro workspace';
  end if;
  if (select count(*) from public.profiles) <> 1 then
    raise exception 'FALHOU: Carla enxerga perfis de quem não divide workspace';
  end if;

  delete from public.workspaces where id = current_setting('test.ws')::uuid;
  begin
    insert into public.products (workspace_id, name) values (current_setting('test.ws')::uuid, 'Intruso');
    raise exception 'FALHOU: Carla criou produto em outro workspace';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.remove_workspace_member(current_setting('test.ws')::uuid, '00000000-0000-0000-0000-00000000000b');
    raise exception 'FALHOU: Carla removeu membro de outro workspace';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------- anon
reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from public.sales;
    raise exception 'FALHOU: anon leu sales';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.create_workspace('anon');
    raise exception 'FALHOU: anon criou workspace';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------- convite aceito ao confirmar o e-mail
reset role;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000d', 'davi@teste.nishiads.dev');
do $$ begin
  if exists (select 1 from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000d') then
    raise exception 'FALHOU: convite aceito antes de confirmar o e-mail';
  end if;
end $$;
update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-00000000000d';
do $$ begin
  if (select role from public.workspace_members where user_id = '00000000-0000-0000-0000-00000000000d') <> 'admin' then
    raise exception 'FALHOU: convite não virou membro admin após confirmação';
  end if;
  if exists (select 1 from public.workspace_invitations where email = 'davi@teste.nishiads.dev') then
    raise exception 'FALHOU: convite aceito não foi apagado';
  end if;
end $$;

-- ---------------------------------------------------------------- Davi (admin): limites do admin
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000d","role":"authenticated"}', true);

do $$ begin
  update public.workspaces set name = 'Agência da Ana & Davi' where id = current_setting('test.ws')::uuid;
  if (select name from public.workspaces where id = current_setting('test.ws')::uuid) <> 'Agência da Ana & Davi' then
    raise exception 'FALHOU: admin não conseguiu renomear';
  end if;
  delete from public.workspaces where id = current_setting('test.ws')::uuid;
  if not exists (select 1 from public.workspaces where id = current_setting('test.ws')::uuid) then
    raise exception 'FALHOU: admin excluiu o workspace (só owner pode)';
  end if;
  begin
    perform public.update_workspace_member_role(current_setting('test.ws')::uuid, '00000000-0000-0000-0000-00000000000a', 'viewer');
    raise exception 'FALHOU: admin rebaixou o owner';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.update_workspace_member_role(current_setting('test.ws')::uuid, auth.uid(), 'owner');
    raise exception 'FALHOU: admin se promoveu a owner';
  exception when insufficient_privilege then null;
  end;
  perform public.update_workspace_member_role(current_setting('test.ws')::uuid, '00000000-0000-0000-0000-00000000000b', 'admin');
  insert into public.products (workspace_id, name, cost_cents) values (current_setting('test.ws')::uuid, 'Curso', 3000);
  begin
    update public.ad_accounts set token_ref = gen_random_uuid();
    raise exception 'FALHOU: admin alterou token_ref';
  exception when insufficient_privilege then null;
  end;
  update public.ad_accounts set is_tracked = true;
  if not (select is_tracked from public.ad_accounts limit 1) then
    raise exception 'FALHOU: admin não marcou a conta para acompanhar';
  end if;
end $$;

-- ---------------------------------------------------------------- Ana: regra do último owner e limpeza do Vault
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

do $$ begin
  begin
    perform public.remove_workspace_member(current_setting('test.ws')::uuid, auth.uid());
    raise exception 'FALHOU: último owner saiu do workspace';
  exception when check_violation then null;
  end;
  begin
    perform public.update_workspace_member_role(current_setting('test.ws')::uuid, auth.uid(), 'admin');
    raise exception 'FALHOU: último owner se rebaixou';
  exception when check_violation then null;
  end;
  perform public.update_workspace_member_role(current_setting('test.ws')::uuid, '00000000-0000-0000-0000-00000000000d', 'owner');
  perform public.remove_workspace_member(current_setting('test.ws')::uuid, auth.uid());
  if exists (select 1 from public.workspaces where id = current_setting('test.ws')::uuid) then
    raise exception 'FALHOU: Ana ainda vê o workspace depois de sair';
  end if;
end $$;

reset role;
do $$
declare v_before int; v_after int;
begin
  select count(*) into v_before from vault.secrets;
  delete from public.workspaces where id = current_setting('test.ws')::uuid;
  select count(*) into v_after from vault.secrets;
  if v_before - v_after <> 2 then
    raise exception 'FALHOU: segredos do Vault não foram apagados com o workspace (antes %, depois %)', v_before, v_after;
  end if;
end $$;

\o
select 'OK: todos os testes de RLS da etapa 1 passaram' as resultado;
rollback;
