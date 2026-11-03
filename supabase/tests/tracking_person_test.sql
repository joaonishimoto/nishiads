-- Testes do rastreamento: eventos sem UTM herdam o anúncio do cadastro da mesma pessoa.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/tracking_person_test.sql

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

insert into public.tracking_sources (id, workspace_id, name, public_key)
values ('a5000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Drinfy', repeat('d', 64));

set local role service_role;
do $$
declare r jsonb; v_key text := repeat('d', 64);
begin
  -- Cadastro pelo anúncio (o id do evento é o id do usuário).
  r := public.service_track_event(v_key, jsonb_build_object(
    'event', 'cadastro', 'dedupe_key', 'user-1', 'visitor_id', 'v1',
    'utm_source', 'FB', 'utm_content', 'c4-c quanto de cachaca|1204000001'));
  if r->>'attribution_status' <> 'matched' then raise exception 'FALHOU: cadastro: %', r; end if;

  -- 1. Teste de outro navegador, sem UTM, com o usuário → herda o anúncio do cadastro.
  r := public.service_track_event(v_key, jsonb_build_object(
    'event', 'teste', 'dedupe_key', 'cs_1', 'visitor_id', 'v9', 'person_ref', 'user-1'));
  if r->>'attribution_status' <> 'matched' then raise exception 'FALHOU: teste pelo usuário: %', r; end if;
  if (select person_ref from public.tracking_events where dedupe_key = 'cs_1') <> 'user-1' then
    raise exception 'FALHOU: person_ref não gravado';
  end if;

  -- 2. Sem usuário, mas no mesmo navegador do cadastro → herda pelo visitante.
  r := public.service_track_event(v_key, jsonb_build_object(
    'event', 'teste', 'dedupe_key', 'cs_2', 'visitor_id', 'v1'));
  if r->>'attribution_status' <> 'matched' then raise exception 'FALHOU: teste pelo visitante: %', r; end if;

  -- 3. UTM próprio vale mais que o herdado.
  r := public.service_track_event(v_key, jsonb_build_object(
    'event', 'teste', 'dedupe_key', 'cs_3', 'person_ref', 'user-1', 'utm_content', 'Outro|1204000777'));
  if r->>'attribution_status' <> 'partial' then raise exception 'FALHOU: UTM próprio: %', r; end if;

  -- 4. Pessoa sem cadastro com UTM → continua sem anúncio.
  r := public.service_track_event(v_key, jsonb_build_object(
    'event', 'teste', 'dedupe_key', 'cs_4', 'visitor_id', 'v7', 'person_ref', 'user-7'));
  if r->>'attribution_status' <> 'unattributed' then raise exception 'FALHOU: sem origem: %', r; end if;
end $$;

-- Coluna "Custo por teste" entra nos templates de Campanhas que já mostram Testes.
reset role;
insert into public.view_templates (workspace_id, user_id, page, name, items) values
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'campaigns', 'T1', array['spend','trials','cpl','sales']);
do $$ begin
  update public.view_templates
  set items = case
    when 'cpl' = any (items) then
      items[1:array_position(items, 'cpl')] || array['cpt'] || items[array_position(items, 'cpl') + 1:]
    else
      items[1:array_position(items, 'trials')] || array['cpt'] || items[array_position(items, 'trials') + 1:]
  end
  where page = 'campaigns' and 'trials' = any (items) and not ('cpt' = any (items));
  if (select items from public.view_templates where name = 'T1') <> array['spend','trials','cpl','cpt','sales'] then
    raise exception 'FALHOU: cpt no template: %', (select items from public.view_templates where name = 'T1');
  end if;
end $$;

\o
select 'OK: herança de origem por pessoa passou' as resultado;
rollback;
