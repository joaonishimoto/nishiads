-- Testes: aviso de checkout com falha (gravação, origem, espera, recuperação e repetição).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/checkout_failures_test.sql
\set ON_ERROR_STOP 1
\o /dev/null
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000c1', 'outro@teste.nishiads.dev', now());
insert into public.workspaces (id, name) values
  ('a0000000-0000-0000-0000-000000000001', 'WS checkout'),
  ('b0000000-0000-0000-0000-000000000001', 'WS outro');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('b0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', 'owner');

insert into public.ad_accounts (id, workspace_id, external_id, name)
values ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'act_1', 'Conta');
insert into public.campaigns (id, workspace_id, ad_account_id, external_id, name) values
  ('a2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', '1202000001', 'Festa');
insert into public.adsets (id, workspace_id, ad_account_id, campaign_id, external_id, name) values
  ('a3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', '1203000001', 'Aberto');
insert into public.ads (id, workspace_id, ad_account_id, campaign_id, adset_id, external_id, name) values
  ('a4000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', '1204000001', 'Vídeo 3');
insert into public.tracking_sources (id, workspace_id, name, public_key)
values ('a5000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Drinfy', repeat('d', 64));

set local role service_role;
do $$
declare
  ws uuid := 'a0000000-0000-0000-0000-000000000001';
  r jsonb;
  n integer;
  c record;
  f public.checkout_failures;
begin
  r := public.service_track_event(repeat('d', 64), jsonb_build_object(
    'event', 'cadastro', 'dedupe_key', 'user-1', 'utm_source', 'FB',
    'utm_content', 'Vídeo 3|1204000001', 'touched_at', now()));

  -- 1. Checkout abandonado sem UTM: herda o anúncio do cadastro da pessoa e avisa já.
  r := public.service_record_checkout_failure(ws, null, 'stripe', jsonb_build_object(
    'kind', 'expired', 'external_ref', 'cs_1', 'session_ref', 'cs_1', 'person_ref', 'user-1',
    'amount_cents', 0, 'product_name', 'Drinfy Anual',
    'started_at', now() - interval '24 hours', 'occurred_at', now(), 'delay_minutes', 0));
  if not (r->>'inserted')::boolean then raise exception 'FALHOU: não gravou: %', r; end if;
  select * into f from public.checkout_failures where external_ref = 'cs_1';
  if f.ad_id is distinct from 'a4000000-0000-0000-0000-000000000001'::uuid
     or f.campaign_id is distinct from 'a2000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'FALHOU: origem não herdada: %', f;
  end if;

  -- 2. O mesmo evento de novo não duplica.
  r := public.service_record_checkout_failure(ws, null, 'stripe', jsonb_build_object(
    'kind', 'expired', 'external_ref', 'cs_1', 'person_ref', 'user-1'));
  if (r->>'inserted')::boolean then raise exception 'FALHOU: duplicou: %', r; end if;

  -- 3. Outro checkout abandonado da mesma pessoa, minutos depois.
  r := public.service_record_checkout_failure(ws, null, 'stripe', jsonb_build_object(
    'kind', 'expired', 'external_ref', 'cs_2', 'person_ref', 'user-1',
    'started_at', now() - interval '23 hours', 'occurred_at', now() + interval '1 second'));

  -- 4. Cartão recusado de outra pessoa: espera 20 minutos.
  r := public.service_record_checkout_failure(ws, null, 'stripe', jsonb_build_object(
    'kind', 'declined', 'external_ref', 'seti_1', 'person_ref', 'user-9', 'reason_code', 'insufficient_funds',
    'started_at', now() - interval '30 minutes', 'occurred_at', now() - interval '30 minutes', 'delay_minutes', 20));

  -- 5. Cobrança recusada no fim do teste.
  r := public.service_record_checkout_failure(ws, null, 'stripe', jsonb_build_object(
    'kind', 'renewal_failed', 'external_ref', 'in_1', 'subscription_ref', 'sub_9', 'amount_cents', 6700,
    'person_ref', 'user-5'));

  -- Primeira rodada: avisa cs_1 (com nomes) e in_1; cs_2 é repetido; seti_1 ainda espera.
  n := 0;
  for c in select * from public.service_claim_checkout_failures(50) loop
    n := n + 1;
    if c.kind = 'expired' and (c.ad_name <> 'Vídeo 3' or c.campaign_name <> 'Festa') then
      raise exception 'FALHOU: nomes da origem: %', c;
    end if;
  end loop;
  if n <> 2 then raise exception 'FALHOU: esperava 2 avisos, veio %', n; end if;
  select * into f from public.checkout_failures where external_ref = 'cs_2';
  if f.resolution is distinct from 'duplicate' then raise exception 'FALHOU: cs_2 deveria ser repetido: %', f.resolution; end if;
  select * into f from public.checkout_failures where external_ref = 'seti_1';
  if f.resolution is not null then raise exception 'FALHOU: recusa avisou antes da hora'; end if;

  -- A pessoa acerta o cartão: o teste entra e a recusa vencida não avisa.
  update public.checkout_failures set notify_after = now() - interval '1 minute' where external_ref = 'seti_1';
  r := public.service_ingest_sale(ws, null, 'stripe', jsonb_build_object(
    'external_order_id', 'sub_1', 'subscription_ref', 'sub_1', 'status', 'trialing', 'gross_amount_cents', 0,
    'person_ref', 'user-9'));
  select count(*) into n from public.service_claim_checkout_failures(50);
  if n <> 0 then raise exception 'FALHOU: avisou recusa recuperada'; end if;
  select * into f from public.checkout_failures where external_ref = 'seti_1';
  if f.resolution is distinct from 'recovered' then raise exception 'FALHOU: seti_1: %', f.resolution; end if;

  -- Recusa sem recuperação avisa depois da espera.
  r := public.service_record_checkout_failure(ws, null, 'stripe', jsonb_build_object(
    'kind', 'declined', 'external_ref', 'seti_2', 'customer_email_hash', repeat('a', 64), 'delay_minutes', 0));
  select count(*) into n from public.service_claim_checkout_failures(50);
  if n <> 1 then raise exception 'FALHOU: recusa não avisou'; end if;

  -- Preferência: quem desliga "Checkout com falha" não recebe.
  update public.notification_preferences set notify_checkout_failures = false
  where workspace_id = ws and user_id = '00000000-0000-0000-0000-0000000000a1';
  insert into public.notification_subscriptions (workspace_id, user_id, channel, endpoint, config, active)
  values (ws, '00000000-0000-0000-0000-0000000000a1', 'webpush', 'https://push.example/1', '{}', true);
  select count(*) into n from public.service_notification_recipients(ws, 'checkout_failure', 0);
  if n <> 0 then raise exception 'FALHOU: preferência desligada ainda recebe'; end if;
  update public.notification_preferences set notify_checkout_failures = true
  where workspace_id = ws and user_id = '00000000-0000-0000-0000-0000000000a1';
  select count(*) into n from public.service_notification_recipients(ws, 'checkout_failure', 0);
  if n <> 1 then raise exception 'FALHOU: preferência ligada não recebe'; end if;
end $$;

-- RLS: membro do workspace lê; de outro workspace, não.
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
do $$
begin
  if (select count(*) from public.checkout_failures) = 0 then raise exception 'FALHOU: owner não lê'; end if;
end $$;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
do $$
begin
  if (select count(*) from public.checkout_failures) <> 0 then raise exception 'FALHOU: outro workspace lê'; end if;
end $$;

rollback;
\o
\echo checkout_failures_test: OK
