-- Testes do rastreamento próprio: fontes, eventos idempotentes, atribuição por UTM e RLS.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/tracking_test.sql

\set ON_ERROR_STOP 1
\o /dev/null
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'viewer@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000c1', 'outro@teste.nishiads.dev', now());

insert into public.workspaces (id, name) values
  ('a0000000-0000-0000-0000-000000000001', 'WS rastreio'),
  ('b0000000-0000-0000-0000-000000000001', 'WS outro');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', 'viewer'),
  ('b0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', 'owner');

insert into public.ad_accounts (id, workspace_id, external_id, name)
values ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'act_1', 'Conta');
insert into public.campaigns (id, workspace_id, ad_account_id, external_id, name) values
  ('a2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', '1202000001', 'Cadastros');
insert into public.adsets (id, workspace_id, ad_account_id, campaign_id, external_id, name) values
  ('a3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', '1203000001', 'Aberto');
insert into public.ads (id, workspace_id, ad_account_id, campaign_id, adset_id, external_id, name) values
  ('a4000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', '1204000001', 'c4-c quanto de cachaca');

-- Owner cria a fonte; viewer não.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.create_tracking_source('a0000000-0000-0000-0000-000000000001', 'Drinfy');
    raise exception 'FALHOU: viewer criou fonte de rastreamento';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
do $$ declare v public.tracking_sources;
begin
  v := public.create_tracking_source('a0000000-0000-0000-0000-000000000001', '  Drinfy  ');
  if v.name <> 'Drinfy' or v.public_key !~ '^[0-9a-f]{64}$' then
    raise exception 'FALHOU: fonte criada errada: %', v;
  end if;
  begin
    insert into public.tracking_events (workspace_id, source_id, event, dedupe_key)
    values ('a0000000-0000-0000-0000-000000000001', v.id, 'cadastro', 'x');
    raise exception 'FALHOU: app inseriu evento direto';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
set local role service_role;
do $$
declare r jsonb; v_key text;
begin
  select public_key into v_key from public.tracking_sources where name = 'Drinfy';

  -- 1. Com UTM do anúncio → matched, com a hierarquia.
  r := public.service_track_event(v_key, jsonb_build_object(
    'event', 'cadastro', 'dedupe_key', 'user-1', 'visitor_id', 'v1',
    'utm_source', 'FB', 'utm_campaign', 'Cadastros|1202000001', 'utm_medium', 'Aberto|1203000001',
    'utm_content', 'c4-c quanto de cachaca|1204000001', 'touched_at', '2026-10-29T12:00:00Z'));
  if r->>'attribution_status' <> 'matched' or (r->>'event_id') is null then
    raise exception 'FALHOU: evento com ids: %', r;
  end if;
  if (select ad_id::text || adset_id::text || campaign_id::text from public.tracking_events where dedupe_key = 'user-1')
     <> 'a4000000-0000-0000-0000-000000000001a3000000-0000-0000-0000-000000000001a2000000-0000-0000-0000-000000000001' then
    raise exception 'FALHOU: hierarquia do evento';
  end if;

  -- Com o rastreamento recebendo cadastros, o aviso em lote da Meta fica desligado.
  insert into public.notification_subscriptions (workspace_id, user_id, channel, endpoint, config)
  values ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'webpush', 'https://push.test/1', '{}');
  insert into public.notification_preferences (workspace_id, user_id)
  values ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1')
  on conflict do nothing;
  if (select count(*) from public.service_notification_recipients('a0000000-0000-0000-0000-000000000001', 'tracked_registration', 0)) <> 1 then
    raise exception 'FALHOU: push do cadastro rastreado sem destinatário';
  end if;
  if (select count(*) from public.service_notification_recipients('a0000000-0000-0000-0000-000000000001', 'registration', 0)) <> 0 then
    raise exception 'FALHOU: push da Meta deveria ficar desligado com o rastreamento ativo';
  end if;

  -- 2. O mesmo cadastro de novo não conta duas vezes.
  r := public.service_track_event(v_key, jsonb_build_object('event', 'cadastro', 'dedupe_key', 'user-1'));
  if (r->>'duplicate')::boolean is not true or (select count(*) from public.tracking_events) <> 1 then
    raise exception 'FALHOU: cadastro repetido: %', r;
  end if;

  -- 3. Sem UTM → unattributed. Anúncio que ainda não sincronizou → partial, e casa depois.
  r := public.service_track_event(v_key, jsonb_build_object('event', 'cadastro', 'dedupe_key', 'user-2'));
  if r->>'attribution_status' <> 'unattributed' then raise exception 'FALHOU: sem UTM: %', r; end if;
  r := public.service_track_event(v_key, jsonb_build_object('event', 'cadastro', 'dedupe_key', 'user-3',
    'utm_content', 'Novo criativo|1204000099'));
  if r->>'attribution_status' <> 'partial' then raise exception 'FALHOU: anúncio desconhecido: %', r; end if;
  insert into public.ads (id, workspace_id, ad_account_id, campaign_id, adset_id, external_id, name) values
    ('a4000000-0000-0000-0000-000000000099', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
     'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', '1204000099', 'Novo criativo');
  perform public.service_reattribute_sales('a0000000-0000-0000-0000-000000000001');
  if (select attribution_status from public.tracking_events where dedupe_key = 'user-3') <> 'matched' then
    raise exception 'FALHOU: reatribuição depois da sincronização';
  end if;

  -- 4. Chave desconhecida ou fonte pausada → recusa.
  r := public.service_track_event(repeat('0', 64), jsonb_build_object('event', 'cadastro', 'dedupe_key', 'z'));
  if (r->>'ok')::boolean then raise exception 'FALHOU: chave desconhecida aceita'; end if;
  update public.tracking_sources set active = false where public_key = v_key;
  r := public.service_track_event(v_key, jsonb_build_object('event', 'cadastro', 'dedupe_key', 'user-4'));
  if (r->>'ok')::boolean then raise exception 'FALHOU: fonte pausada aceitou evento'; end if;
  if (select last_event_at from public.tracking_sources where public_key = v_key) is null then
    raise exception 'FALHOU: last_event_at';
  end if;
end $$;

-- Membros leem; outro workspace não vê nada.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.tracking_events) <> 3 then raise exception 'FALHOU: viewer deveria ver 3 eventos'; end if;
  begin
    perform public.service_track_event(repeat('0', 64), '{}'::jsonb);
    raise exception 'FALHOU: authenticated chamou service_track_event';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
do $$ begin
  if (select count(*) from public.tracking_events) <> 0 or (select count(*) from public.tracking_sources) <> 0 then
    raise exception 'FALHOU: outro workspace vê o rastreamento';
  end if;
end $$;

\o
select 'OK: testes do rastreamento passaram' as resultado;
rollback;
