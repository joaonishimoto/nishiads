-- Testes do resumo diário: permissões, números do dia no fuso do workspace e agenda
-- (um envio por dia, janela de 2 horas, envio perto da meia-noite).
\set ON_ERROR_STOP 1
\o /dev/null
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000f1', 'resumo-a@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000f2', 'resumo-b@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000f3', 'resumo-intruso@teste.nishiads.dev', now());
insert into public.workspaces (id, name, timezone, currency)
values ('f0000000-0000-0000-0000-000000000001', 'WS resumo', 'America/Sao_Paulo', 'BRL');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('f0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f1', 'owner'),
  ('f0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f2', 'viewer');

insert into public.ad_accounts (id, workspace_id, external_id, name, is_tracked)
values ('fa000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', '222', 'Conta', true);
insert into public.campaigns (id, workspace_id, ad_account_id, external_id, name, effective_status) values
  ('fc000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'fa000000-0000-0000-0000-000000000001', 'c1', 'Campanha', 'ACTIVE');
insert into public.adsets (id, workspace_id, ad_account_id, campaign_id, external_id, name, effective_status) values
  ('f5000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'fa000000-0000-0000-0000-000000000001',
   'fc000000-0000-0000-0000-000000000001', 's1', 'Conjunto', 'ACTIVE');
insert into public.ads (id, workspace_id, ad_account_id, campaign_id, adset_id, external_id, name, effective_status) values
  ('fd000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'fa000000-0000-0000-0000-000000000001',
   'fc000000-0000-0000-0000-000000000001', 'f5000000-0000-0000-0000-000000000001', 'a1', 'Vídeo', 'ACTIVE');
insert into public.products (id, workspace_id, provider, external_product_id, name, sale_value_cents)
values ('fb000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'stripe', 'p1', 'Plano', 6700);

-- Dia 05/11 em SP: gasto R$ 100, 3 cadastros pela Meta; uma venda de R$ 67; três testes
-- (um já convertido); um teste de ontem 23:30 em SP fica fora.
insert into public.ad_insights_daily (ad_id, date, workspace_id, ad_account_id, spend_cents, registrations, trials) values
  ('fd000000-0000-0000-0000-000000000001', '2026-11-05', 'f0000000-0000-0000-0000-000000000001', 'fa000000-0000-0000-0000-000000000001', 10000, 3, 1),
  ('fd000000-0000-0000-0000-000000000001', '2026-11-04', 'f0000000-0000-0000-0000-000000000001', 'fa000000-0000-0000-0000-000000000001', 50000, 9, 0);
insert into public.sales (workspace_id, provider, external_order_id, status, gross_amount_cents, currency, paid_at, created_at, product_id, trial_converted_at) values
  ('f0000000-0000-0000-0000-000000000001', 'stripe', 'r-1', 'approved', 6700, 'BRL', '2026-11-05 15:00:00+00', '2026-11-05 15:00:00+00', 'fb000000-0000-0000-0000-000000000001', null),
  ('f0000000-0000-0000-0000-000000000001', 'stripe', 'r-2', 'trialing', 0, 'BRL', null, '2026-11-05 13:00:00+00', 'fb000000-0000-0000-0000-000000000001', null),
  ('f0000000-0000-0000-0000-000000000001', 'stripe', 'r-3', 'trialing', 0, 'BRL', null, '2026-11-05 14:00:00+00', 'fb000000-0000-0000-0000-000000000001', null),
  ('f0000000-0000-0000-0000-000000000001', 'stripe', 'r-4', 'trialing', 0, 'BRL', null, '2026-11-05 16:00:00+00', 'fb000000-0000-0000-0000-000000000001', '2026-11-05 20:00:00+00'),
  ('f0000000-0000-0000-0000-000000000001', 'stripe', 'r-5', 'trialing', 0, 'BRL', null, '2026-11-05 02:30:00+00', 'fb000000-0000-0000-0000-000000000001', null);

do $$
declare n jsonb;
begin
  n := private.daily_summary_numbers('f0000000-0000-0000-0000-000000000001', '2026-11-05', null);
  if (n ->> 'spend_cents')::bigint <> 10000 then raise exception 'FALHOU: gasto %', n; end if;
  if (n ->> 'registrations')::int <> 3 then raise exception 'FALHOU: cadastros da Meta %', n; end if;
  if (n ->> 'trials')::int <> 3 then raise exception 'FALHOU: testes do checkout (esperava 3) %', n; end if;
  if (n ->> 'open_trials')::int <> 2 then raise exception 'FALHOU: testes em andamento %', n; end if;
  if (n ->> 'trial_value_cents')::bigint <> 13400 then raise exception 'FALHOU: valor dos testes %', n; end if;
  if (n ->> 'sales')::int <> 1 or (n ->> 'revenue_cents')::bigint <> 6700 then raise exception 'FALHOU: vendas %', n; end if;
  if (n ->> 'roas')::numeric <> 0.67 then raise exception 'FALHOU: roas %', n; end if;
  if (n ->> 'trial_roas')::numeric <> 2.01 then raise exception 'FALHOU: roas com testes %', n; end if;
  -- Até as 11:00 de SP (14:00 UTC): só o teste das 10:00 de SP.
  n := private.daily_summary_numbers('f0000000-0000-0000-0000-000000000001', '2026-11-05', '2026-11-05 14:00:00+00');
  if (n ->> 'trials')::int <> 1 or (n ->> 'sales')::int <> 0 then raise exception 'FALHOU: corte no horário %', n; end if;
end $$;

-- Rastreamento próprio vale mais que a Meta para cadastros.
insert into public.tracking_sources (id, workspace_id, name)
values ('fe000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'Site');
insert into public.tracking_events (workspace_id, source_id, event, dedupe_key, occurred_at) values
  ('f0000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'cadastro', 'u1', '2026-11-05 12:00:00+00'),
  ('f0000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'cadastro', 'u2', '2026-11-05 13:00:00+00'),
  ('f0000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'cadastro', 'u3', '2026-11-05 14:00:00+00'),
  ('f0000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'cadastro', 'u4', '2026-11-05 15:00:00+00'),
  ('f0000000-0000-0000-0000-000000000001', 'fe000000-0000-0000-0000-000000000001', 'cadastro', 'u5', '2026-11-04 15:00:00+00');
do $$ begin
  if (private.daily_summary_numbers('f0000000-0000-0000-0000-000000000001', '2026-11-05', null) ->> 'registrations')::int <> 4 then
    raise exception 'FALHOU: cadastros do rastreamento';
  end if;
end $$;

-- --------------------------------------------------------------- Permissões
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1"}', true);
insert into public.daily_summary_settings (workspace_id, user_id, send_time, period)
values ('f0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f1', '21:00', 'today');
select public.daily_summary_numbers('f0000000-0000-0000-0000-000000000001', 'yesterday');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2"}', true);
insert into public.daily_summary_settings (workspace_id, user_id, send_time, period)
values ('f0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f2', '23:58', 'yesterday');
do $$ begin
  if exists (select 1 from public.daily_summary_settings where user_id = '00000000-0000-0000-0000-0000000000f1') then
    raise exception 'FALHOU: viu o resumo de outra pessoa';
  end if;
  update public.daily_summary_settings set enabled = false where user_id = '00000000-0000-0000-0000-0000000000f1';
  if found then raise exception 'FALHOU: editou o resumo de outra pessoa'; end if;
  begin
    insert into public.daily_summary_settings (workspace_id, user_id)
    values ('f0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f1');
    raise exception 'FALHOU: criou resumo para outra pessoa';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.daily_summary_settings set last_sent_on = '2030-01-01';
    raise exception 'FALHOU: mudou last_sent_on';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.service_claim_daily_summaries();
    raise exception 'FALHOU: authenticated chamou service_claim_daily_summaries';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f3"}', true);
do $$ begin
  begin
    insert into public.daily_summary_settings (workspace_id, user_id)
    values ('f0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f3');
    raise exception 'FALHOU: não membro criou resumo';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  begin
    perform public.daily_summary_numbers('f0000000-0000-0000-0000-000000000001', 'today');
    raise exception 'FALHOU: não membro leu os números';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- --------------------------------------------------------------- Agenda
do $$
declare
  r record;
  n int;
begin
  -- 20:59 em SP: nada vence.
  select count(*) into n from public.service_claim_daily_summaries('2026-11-05 23:59:00+00');
  if n <> 0 then raise exception 'FALHOU: enviou antes da hora (%)', n; end if;

  -- 21:03 em SP: vence o de A (hoje, até 21:00).
  select * into strict r from public.service_claim_daily_summaries('2026-11-06 00:03:00+00');
  if r.user_id <> '00000000-0000-0000-0000-0000000000f1' or r.summary_day <> '2026-11-05'
     or r.until_at <> '2026-11-06 00:00:00+00' then
    raise exception 'FALHOU: resumo de A %', r;
  end if;
  -- Cinco minutos depois: não repete.
  select count(*) into n from public.service_claim_daily_summaries('2026-11-06 00:08:00+00');
  if n <> 0 then raise exception 'FALHOU: repetiu o resumo (%)', n; end if;

  -- 00:02 de 06/11 em SP: vence o de B, marcado às 23:58 de 05/11 (números de 04/11, dia inteiro).
  select * into strict r from public.service_claim_daily_summaries('2026-11-06 03:02:00+00');
  if r.user_id <> '00000000-0000-0000-0000-0000000000f2' or r.scheduled_on <> '2026-11-05'
     or r.summary_day <> '2026-11-04' or r.until_at is not null then
    raise exception 'FALHOU: resumo de B perto da meia-noite %', r;
  end if;

  -- 23:58 de 06/11: B de novo (outro dia). Desligado não vence; passou de 2 horas também não.
  update public.daily_summary_settings set enabled = false where user_id = '00000000-0000-0000-0000-0000000000f1';
  select count(*) into n from public.service_claim_daily_summaries('2026-11-07 02:58:00+00');
  if n <> 1 then raise exception 'FALHOU: esperava só B no dia seguinte (%)', n; end if;
  update public.daily_summary_settings set enabled = true where user_id = '00000000-0000-0000-0000-0000000000f1';
  select count(*) into n from public.service_claim_daily_summaries('2026-11-07 02:59:00+00');
  if n <> 0 then raise exception 'FALHOU: enviou fora da janela de 2 horas (%)', n; end if;
end $$;

\o
select 'daily_summary_test: ok';
rollback;
