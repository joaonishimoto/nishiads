-- Testes do controle da Meta: histórico de alterações (meta_action_log) e orçamentos.
\set ON_ERROR_STOP 1
\o /dev/null
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'acoes-owner@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000e2', 'acoes-viewer@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000e3', 'acoes-intruso@teste.nishiads.dev', now());
insert into public.workspaces (id, name, timezone) values ('e0000000-0000-0000-0000-000000000001', 'WS ações', 'America/Sao_Paulo');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('e0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', 'owner'),
  ('e0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e2', 'viewer');
insert into public.ad_accounts (id, workspace_id, external_id, name) values
  ('e1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', '222', 'Conta');
insert into public.campaigns (id, workspace_id, ad_account_id, external_id, name, daily_budget_cents) values
  ('e2000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'e1000000-0000-0000-0000-000000000001', '900', 'Campanha', 5000);

-- Orçamento negativo é recusado.
do $$ begin
  begin
    update public.campaigns set daily_budget_cents = -1 where id = 'e2000000-0000-0000-0000-000000000001';
    raise exception 'FALHOU: orçamento negativo aceito';
  exception when check_violation then null;
  end;
end $$;

-- A service_role grava o histórico.
insert into public.meta_action_log (workspace_id, ad_account_id, level, object_id, external_id, object_name, action,
  previous, requested, ok, source, actor_user_id)
values ('e0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'campaign',
  'e2000000-0000-0000-0000-000000000001', '900', 'Campanha', 'pause', '{"status":"ACTIVE"}', '{"status":"PAUSED"}',
  true, 'manual', '00000000-0000-0000-0000-0000000000e1');

do $$ begin
  begin
    insert into public.meta_action_log (workspace_id, level, object_id, external_id, action, ok)
    values ('e0000000-0000-0000-0000-000000000001', 'campaign', gen_random_uuid(), '1', 'apagar', true);
    raise exception 'FALHOU: ação desconhecida aceita';
  exception when check_violation then null;
  end;
end $$;

-- Membro (até viewer) lê; ninguém do app escreve ou apaga.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.meta_action_log;
  if n <> 1 then raise exception 'FALHOU: viewer deveria ver 1 ação, viu %', n; end if;
  begin
    insert into public.meta_action_log (workspace_id, level, object_id, external_id, action, ok)
    values ('e0000000-0000-0000-0000-000000000001', 'ad', gen_random_uuid(), '1', 'pause', true);
    raise exception 'FALHOU: authenticated gravou no histórico';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.campaigns set daily_budget_cents = 1 where id = 'e2000000-0000-0000-0000-000000000001';
    raise exception 'FALHOU: authenticated mudou orçamento direto na tabela';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1"}', true);
do $$
begin
  begin
    delete from public.meta_action_log;
    raise exception 'FALHOU: owner apagou o histórico';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e3"}', true);
do $$ begin
  if exists (select 1 from public.meta_action_log) then raise exception 'FALHOU: intruso viu o histórico'; end if;
end $$;
reset role;

rollback;
\o
\echo 'meta_actions_test: ok'
