-- Testes da etapa 4: conexão com a Meta, state do OAuth, trava de sincronização e desconexão.
\set ON_ERROR_STOP 1
\o /dev/null
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000d1', 'meta-owner@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000d2', 'meta-viewer@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000d3', 'meta-intruso@teste.nishiads.dev', now());
insert into public.workspaces (id, name, timezone) values ('d0000000-0000-0000-0000-000000000001', 'WS meta', 'America/Sao_Paulo');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('d0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d1', 'owner'),
  ('d0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000d2', 'viewer');

-- Viewer não inicia o OAuth; o state é de uso único.
do $$
declare v_state text; n int;
begin
  begin
    perform public.service_create_meta_oauth_state('d0000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-0000000000d2', 'https://app.exemplo/w');
    raise exception 'FALHOU: viewer criou state de OAuth';
  exception when insufficient_privilege then null;
  end;
  v_state := public.service_create_meta_oauth_state('d0000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-0000000000d1', 'https://app.exemplo/w');
  select count(*) into n from public.service_consume_meta_oauth_state(v_state);
  if n <> 1 then raise exception 'FALHOU: state válido não foi aceito'; end if;
  select count(*) into n from public.service_consume_meta_oauth_state(v_state);
  if n <> 0 then raise exception 'FALHOU: state foi aceito duas vezes'; end if;
end $$;

-- Conectar duas vezes renova o token e apaga o anterior do Vault.
do $$
declare v_id uuid; v_id2 uuid; v_old uuid; n int;
begin
  v_id := public.service_upsert_meta_connection('d0000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-0000000000d1', '1234567890', 'João', 'token-1', now() + interval '60 days', array['ads_read']);
  select token_ref into v_old from public.meta_connections where id = v_id;
  v_id2 := public.service_upsert_meta_connection('d0000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-0000000000d1', '1234567890', 'João', 'token-2', now() + interval '60 days', array['ads_read']);
  if v_id <> v_id2 then raise exception 'FALHOU: reconexão criou outra conexão'; end if;
  if exists (select 1 from vault.secrets where id = v_old) then raise exception 'FALHOU: token antigo ficou no Vault'; end if;
  if public.service_read_secret((select token_ref from public.meta_connections where id = v_id)) <> 'token-2' then
    raise exception 'FALHOU: token novo não foi salvo';
  end if;

  insert into public.ad_accounts (id, workspace_id, external_id, name, meta_connection_id, is_tracked)
  values ('d1000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', '111', 'Conta 1', v_id, true);

  -- Trava: só uma execução por vez; trava velha pode ser retomada.
  if not public.service_claim_ad_account_sync('d1000000-0000-0000-0000-000000000001') then
    raise exception 'FALHOU: não travou conta livre';
  end if;
  if public.service_claim_ad_account_sync('d1000000-0000-0000-0000-000000000001') then
    raise exception 'FALHOU: travou conta já travada';
  end if;
  update public.ad_accounts set sync_started_at = now() - interval '11 minutes' where id = 'd1000000-0000-0000-0000-000000000001';
  if not public.service_claim_ad_account_sync('d1000000-0000-0000-0000-000000000001') then
    raise exception 'FALHOU: não retomou trava velha';
  end if;
end $$;

-- Segredo do cron.
insert into vault.secrets (name, secret) values ('nishiads_cron_secret', repeat('a', 64));
do $$ begin
  if not public.service_check_cron_secret(repeat('a', 64)) then raise exception 'FALHOU: segredo do cron recusado'; end if;
  if public.service_check_cron_secret('errado') then raise exception 'FALHOU: segredo errado aceito'; end if;
end $$;

-- authenticated: lê a conexão, não chama funções de serviço, não muda token/status.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d2"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.meta_connections;
  if n <> 1 then raise exception 'FALHOU: viewer deveria ver 1 conexão, viu %', n; end if;
  begin
    perform public.service_read_secret(gen_random_uuid());
    raise exception 'FALHOU: authenticated leu segredo';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.service_claim_ad_account_sync('d1000000-0000-0000-0000-000000000001');
    raise exception 'FALHOU: authenticated travou sincronização';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.ad_accounts set status = 'active' where id = 'd1000000-0000-0000-0000-000000000001';
    raise exception 'FALHOU: authenticated mudou status da conta';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.disconnect_meta_connection((select id from public.meta_connections limit 1));
    raise exception 'FALHOU: viewer desconectou a Meta';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d3"}', true);
do $$ begin
  if exists (select 1 from public.meta_connections) then raise exception 'FALHOU: intruso viu a conexão'; end if;
end $$;

-- Owner escolhe a conta e desconecta.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1"}', true);
update public.ad_accounts set is_tracked = false where id = 'd1000000-0000-0000-0000-000000000001';
select public.disconnect_meta_connection((select id from public.meta_connections limit 1));
reset role;

do $$ begin
  if exists (select 1 from public.meta_connections) then raise exception 'FALHOU: conexão não foi apagada'; end if;
  if exists (select 1 from vault.secrets where secret like 'token-%') then
    raise exception 'FALHOU: token ficou no Vault depois de desconectar';
  end if;
  if (select status from public.ad_accounts where id = 'd1000000-0000-0000-0000-000000000001') <> 'needs_reconnect'
     or (select meta_connection_id from public.ad_accounts where id = 'd1000000-0000-0000-0000-000000000001') is not null then
    raise exception 'FALHOU: conta não ficou como reconectar';
  end if;
end $$;

rollback;
\o
\echo 'meta_sync_test: ok'
