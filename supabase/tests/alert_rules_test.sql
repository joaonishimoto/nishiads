-- Testes dos alertas e regras automáticas: condições, janela no fuso do workspace,
-- deduplicação, limite de pausas automáticas, expiração e permissões.
\set ON_ERROR_STOP 1
\o /dev/null
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'alerta-owner@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000e2', 'alerta-viewer@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000e3', 'alerta-intruso@teste.nishiads.dev', now());
insert into public.workspaces (id, name, timezone, currency)
values ('e0000000-0000-0000-0000-000000000001', 'WS alertas', 'America/Sao_Paulo', 'BRL');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('e0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', 'owner'),
  ('e0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e2', 'viewer');

insert into public.ad_accounts (id, workspace_id, external_id, name, is_tracked)
values ('ea000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', '111', 'Conta', true);
insert into public.campaigns (id, workspace_id, ad_account_id, external_id, name, effective_status) values
  ('ec000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'ea000000-0000-0000-0000-000000000001', 'c1', 'Campanha A', 'ACTIVE');
insert into public.adsets (id, workspace_id, ad_account_id, campaign_id, external_id, name, effective_status) values
  ('e5000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'ea000000-0000-0000-0000-000000000001',
   'ec000000-0000-0000-0000-000000000001', 's1', 'Conjunto A', 'ACTIVE');
insert into public.ads (id, workspace_id, ad_account_id, campaign_id, adset_id, external_id, name, effective_status) values
  ('ed000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'ea000000-0000-0000-0000-000000000001',
   'ec000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001', 'a1', 'Vídeo sem venda', 'ACTIVE'),
  ('ed000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001', 'ea000000-0000-0000-0000-000000000001',
   'ec000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001', 'a2', 'Vídeo que vende', 'ACTIVE'),
  ('ed000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001', 'ea000000-0000-0000-0000-000000000001',
   'ec000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001', 'a3', 'Pausado', 'PAUSED'),
  ('ed000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000001', 'ea000000-0000-0000-0000-000000000001',
   'ec000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001', 'a4', 'Carrossel', 'ACTIVE');

-- "Agora" = 26/10 12:00 em São Paulo. Hoje: a1 R$ 150 sem venda, a2 R$ 200 com uma venda de
-- R$ 197, a3 (pausado) R$ 500, a4 R$ 30. Ontem: a1 R$ 400 e uma venda de R$ 197 em a1.
insert into public.ad_insights_daily (ad_id, date, workspace_id, ad_account_id, spend_cents) values
  ('ed000000-0000-0000-0000-000000000001', '2026-10-26', 'e0000000-0000-0000-0000-000000000001', 'ea000000-0000-0000-0000-000000000001', 15000),
  ('ed000000-0000-0000-0000-000000000002', '2026-10-26', 'e0000000-0000-0000-0000-000000000001', 'ea000000-0000-0000-0000-000000000001', 20000),
  ('ed000000-0000-0000-0000-000000000003', '2026-10-26', 'e0000000-0000-0000-0000-000000000001', 'ea000000-0000-0000-0000-000000000001', 50000),
  ('ed000000-0000-0000-0000-000000000004', '2026-10-26', 'e0000000-0000-0000-0000-000000000001', 'ea000000-0000-0000-0000-000000000001', 3000),
  ('ed000000-0000-0000-0000-000000000001', '2026-10-25', 'e0000000-0000-0000-0000-000000000001', 'ea000000-0000-0000-0000-000000000001', 40000);
insert into public.sales (workspace_id, provider, external_order_id, status, gross_amount_cents, currency, paid_at,
  campaign_id, adset_id, ad_id, attribution_status) values
  -- Hoje às 09:00 em SP.
  ('e0000000-0000-0000-0000-000000000001', 'kiwify', 'al-1', 'approved', 19700, 'BRL', '2026-10-26 12:00:00+00',
   'ec000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001', 'ed000000-0000-0000-0000-000000000002', 'matched'),
  -- Ontem às 23:30 em SP (já 26/10 em UTC): fica fora de "hoje".
  ('e0000000-0000-0000-0000-000000000001', 'kiwify', 'al-2', 'approved', 19700, 'BRL', '2026-10-26 02:30:00+00',
   'ec000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001', 'ed000000-0000-0000-0000-000000000001', 'matched'),
  -- Outra moeda e reembolsada: não contam.
  ('e0000000-0000-0000-0000-000000000001', 'stripe', 'al-3', 'approved', 5000, 'USD', '2026-10-26 13:00:00+00',
   'ec000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001', 'ed000000-0000-0000-0000-000000000004', 'matched'),
  ('e0000000-0000-0000-0000-000000000001', 'kiwify', 'al-4', 'refunded', 9700, 'BRL', '2026-10-26 13:00:00+00',
   'ec000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001', 'ed000000-0000-0000-0000-000000000004', 'matched');

-- --------------------------------------------------------------- Permissões das regras
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2"}', true);
do $$ begin
  begin
    insert into public.alert_rules (workspace_id, name, condition, level, threshold_cents)
    values ('e0000000-0000-0000-0000-000000000001', 'Viewer', 'spend_without_sale', 'ad', 100);
    raise exception 'FALHOU: viewer criou regra';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1"}', true);
-- Owner cria pelo app (sem id; created_by vem do token).
insert into public.alert_rules (workspace_id, name, condition, level, threshold_cents, enabled)
values ('e0000000-0000-0000-0000-000000000001', 'Criada pelo app', 'spend_without_sale', 'campaign', 99999999, false);
update public.alert_rules set name = 'Renomeada' where name = 'Criada pelo app';

do $$ begin
  begin
    insert into public.alert_rules (workspace_id, name, condition, level)
    values ('e0000000-0000-0000-0000-000000000001', 'ROAS sem meta', 'roas_below', 'ad');
    raise exception 'FALHOU: regra de ROAS sem min_roas foi aceita';
  exception when check_violation then null;
  end;
  begin
    insert into public.alert_rules (workspace_id, name, condition, level)
    values ('e0000000-0000-0000-0000-000000000001', 'Sem valor', 'spend_without_sale', 'ad');
    raise exception 'FALHOU: regra sem threshold_cents foi aceita';
  exception when check_violation then null;
  end;
  begin
    update public.alert_rules set created_by = null where id = 'e1000000-0000-0000-0000-000000000001';
    raise exception 'FALHOU: app alterou created_by';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.service_evaluate_alert_rules('e0000000-0000-0000-0000-000000000001');
    raise exception 'FALHOU: authenticated chamou service_evaluate_alert_rules';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.alerts (workspace_id, rule_name, condition, level, time_window, action, ad_account_id, object_id,
      object_external_id, object_name, period_key, currency, spend_cents, sales, revenue_cents, status)
    values ('e0000000-0000-0000-0000-000000000001', 'x', 'x', 'ad', 'today', 'notify', 'ea000000-0000-0000-0000-000000000001',
      gen_random_uuid(), 'x', 'x', current_date, 'BRL', 0, 0, 0, 'notified');
    raise exception 'FALHOU: authenticated gravou em alerts';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Prévia: o owner vê o que dispararia; quem não é membro, não.
do $$
declare n int;
begin
  select count(*) into n from public.preview_alert_rule('e0000000-0000-0000-0000-000000000001',
    'spend_without_sale', 'ad', 'today', 10000, null, 0);
  -- A prévia usa now(); só confere que roda e respeita o acesso.
  if n < 0 then raise exception 'FALHOU'; end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e3"}', true);
do $$
declare n int;
begin
  begin
    perform * from public.preview_alert_rule('e0000000-0000-0000-0000-000000000001',
      'spend_without_sale', 'ad', 'today', 10000, null, 0);
    raise exception 'FALHOU: intruso usou a prévia';
  exception when insufficient_privilege then null;
  end;
  select count(*) into n from public.alert_rules;
  if n <> 0 then raise exception 'FALHOU: intruso viu % regras', n; end if;
end $$;
reset role;

do $$ begin
  if (select created_by from public.alert_rules where name = 'Renomeada') <> '00000000-0000-0000-0000-0000000000e1' then
    raise exception 'FALHOU: created_by não veio do token';
  end if;
end $$;

-- Regras com id fixo para os testes abaixo.
insert into public.alert_rules (id, workspace_id, name, condition, level, threshold_cents, action) values
  ('e1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'Sem venda', 'spend_without_sale', 'ad', 10000, 'approve_pause');
insert into public.alert_rules (id, workspace_id, name, condition, level, min_roas, min_spend_cents) values
  ('e1000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001', 'ROAS', 'roas_below', 'adset', 2, 5000);
insert into public.alert_rules (id, workspace_id, name, condition, level, threshold_cents) values
  ('e1000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001', 'CPA', 'cpa_above', 'campaign', 10000);
insert into public.alert_rules (id, workspace_id, name, condition, level, threshold_cents, action, max_auto_pauses_per_day) values
  ('e1000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000001', 'Auto', 'spend_without_sale', 'ad', 1000, 'auto_pause', 1);
insert into public.alert_rules (id, workspace_id, name, condition, level, time_window, threshold_cents, enabled) values
  ('e1000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000001', 'CPA 3 dias', 'cpa_above', 'ad', 'last_3d', 30000, false);


-- --------------------------------------------------------------- Condições
do $$
declare
  ws uuid := 'e0000000-0000-0000-0000-000000000001';
  noon timestamptz := '2026-10-26 12:00:00-03';
  r record;
  n int;
begin
  -- Sem venda, R$ 100+: só a1 (a2 vendeu, a3 está pausado, a4 gastou pouco). A venda de
  -- ontem às 23:30 não conta para hoje.
  select count(*) as n, min(object_name) as name, min(spend_cents) as spend into r
  from private.alert_rule_matches(ws, 'spend_without_sale', 'ad', 'today', 10000, null, 0, null, null, noon);
  if r.n <> 1 or r.name <> 'Vídeo sem venda' or r.spend <> 15000 then
    raise exception 'FALHOU: sem venda devolveu % / % / %', r.n, r.name, r.spend;
  end if;

  -- Últimos 3 dias: a1 gastou R$ 550 e teve a venda de ontem → não é "sem venda".
  select count(*) into n
  from private.alert_rule_matches(ws, 'spend_without_sale', 'ad', 'last_3d', 10000, null, 0, null, null, noon)
  where object_name = 'Vídeo sem venda';
  if n <> 0 then raise exception 'FALHOU: janela de 3 dias ignorou a venda de ontem'; end if;

  -- ROAS do conjunto hoje: o gasto soma todos os anúncios, inclusive o pausado
  -- (R$ 880), e a venda de R$ 197 → 0,2239.
  select * into r
  from private.alert_rule_matches(ws, 'roas_below', 'adset', 'today', null, 2, 5000, null, null, noon);
  if r.spend_cents <> 88000 or r.sales <> 1 or r.revenue_cents <> 19700 or r.roas <> 0.2239 then
    raise exception 'FALHOU: ROAS do conjunto % / % / % / %', r.spend_cents, r.sales, r.revenue_cents, r.roas;
  end if;
  select count(*) into n
  from private.alert_rule_matches(ws, 'roas_below', 'adset', 'today', null, 0.2, 5000, null, null, noon);
  if n <> 0 then raise exception 'FALHOU: ROAS 0,22 disparou com meta 0,2'; end if;
  select count(*) into n
  from private.alert_rule_matches(ws, 'roas_below', 'adset', 'today', null, 2, 100000, null, null, noon);
  if n <> 0 then raise exception 'FALHOU: ROAS disparou antes do gasto mínimo'; end if;

  -- CPA: sem venda conta o gasto inteiro; com venda, gasto / vendas.
  select count(*) into n
  from private.alert_rule_matches(ws, 'cpa_above', 'ad', 'today', 10000, null, 0, null, null, noon);
  if n <> 2 then raise exception 'FALHOU: CPA > R$ 100 deveria pegar a1 e a2, pegou %', n; end if;
  select cpa_cents into n
  from private.alert_rule_matches(ws, 'cpa_above', 'ad', 'today', 10000, null, 0, null, null, noon)
  where object_name = 'Vídeo que vende';
  if n <> 20000 then raise exception 'FALHOU: CPA de a2 deveria ser 20000, veio %', n; end if;
  select count(*) into n
  from private.alert_rule_matches(ws, 'cpa_above', 'ad', 'today', 20000, null, 0, null, null, noon);
  if n <> 0 then raise exception 'FALHOU: CPA igual ao máximo disparou (%)', n; end if;

  -- Escopo por campanha e por conta.
  select count(*) into n
  from private.alert_rule_matches(ws, 'spend_without_sale', 'ad', 'today', 1000, null, 0, null,
    gen_random_uuid(), noon);
  if n <> 0 then raise exception 'FALHOU: escopo de campanha não filtrou'; end if;
  select count(*) into n
  from private.alert_rule_matches(ws, 'spend_without_sale', 'ad', 'today', 1000, null, 0,
    'ea000000-0000-0000-0000-000000000001', 'ec000000-0000-0000-0000-000000000001', noon);
  if n <> 2 then raise exception 'FALHOU: escopo certo deveria pegar a1 e a4, pegou %', n; end if;
end $$;

-- --------------------------------------------------------------- Avaliação
do $$
declare
  ws uuid := 'e0000000-0000-0000-0000-000000000001';
  noon timestamptz := '2026-10-26 12:00:00-03';
  n int;
  v public.alerts;
begin
  select count(*) into n from public.service_evaluate_alert_rules(ws, noon);
  -- Sem venda: a1 · ROAS: conjunto · CPA: campanha (R$ 880 > R$ 100 × 1) · Auto: a1 e a4. A regra
  -- desligada não roda.
  if n <> 5 then raise exception 'FALHOU: esperava 5 alertas novos, vieram %', n; end if;

  select * into v from public.alerts where rule_id = 'e1000000-0000-0000-0000-000000000001';
  if v.status <> 'pending' or v.object_name <> 'Vídeo sem venda' or v.period_key <> '2026-10-26' or v.auto_action then
    raise exception 'FALHOU: alerta de aprovação veio % / % / %', v.status, v.object_name, v.period_key;
  end if;
  if (select status from public.alerts where rule_id = 'e1000000-0000-0000-0000-000000000002') <> 'notified' then
    raise exception 'FALHOU: regra só de aviso não ficou notified';
  end if;

  -- Limite de 1 pausa automática por dia: o maior gasto pausa, o outro pede aprovação.
  select * into v from public.alerts where rule_id = 'e1000000-0000-0000-0000-000000000004' and auto_action;
  if v.status <> 'pausing' or v.object_name <> 'Vídeo sem venda' then
    raise exception 'FALHOU: pausa automática veio % / %', v.status, v.object_name;
  end if;
  select * into v from public.alerts where rule_id = 'e1000000-0000-0000-0000-000000000004' and not auto_action;
  if v.status <> 'pending' or v.error is null then
    raise exception 'FALHOU: acima do limite deveria pedir aprovação (%)', v.status;
  end if;

  -- Avaliar de novo no mesmo dia não repete.
  select count(*) into n from public.service_evaluate_alert_rules(ws, noon + interval '15 minutes');
  if n <> 0 then raise exception 'FALHOU: avaliação repetida criou % alertas', n; end if;

  -- Pausa travada há mais de 5 min volta a pedir aprovação; pedido com mais de 24 h expira.
  update public.alerts set updated_at = noon - interval '10 minutes' where status = 'pausing';
  perform public.service_evaluate_alert_rules(ws, noon + interval '20 minutes');
  if exists (select 1 from public.alerts where status = 'pausing') then
    raise exception 'FALHOU: pausa travada não foi solta';
  end if;
  update public.alerts set created_at = noon - interval '25 hours' where rule_id = 'e1000000-0000-0000-0000-000000000001';
  perform public.service_evaluate_alert_rules(ws, noon + interval '25 minutes');
  if (select status from public.alerts where rule_id = 'e1000000-0000-0000-0000-000000000001') <> 'expired' then
    raise exception 'FALHOU: pedido antigo não expirou';
  end if;

  -- No dia seguinte, a mesma regra pode disparar de novo (ROAS dos últimos dias, por exemplo).
  update public.alert_rules set time_window = 'last_3d' where id = 'e1000000-0000-0000-0000-000000000002';
  select count(*) into n from public.service_evaluate_alert_rules(ws, noon + interval '1 day')
  where rule_id = 'e1000000-0000-0000-0000-000000000002';
  if n <> 1 then raise exception 'FALHOU: regra não disparou no dia seguinte (%)', n; end if;
end $$;

-- --------------------------------------------------------------- Ignorar e ler
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.alerts;
  if n < 5 then raise exception 'FALHOU: viewer não lê os alertas (%)', n; end if;
  begin
    perform public.dismiss_alert((select id from public.alerts where status = 'notified' limit 1));
    raise exception 'FALHOU: viewer ignorou alerta';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e3"}', true);
do $$ begin
  if exists (select 1 from public.alerts) then raise exception 'FALHOU: intruso viu alertas'; end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1"}', true);
select public.dismiss_alert((select id from public.alerts where status = 'notified' order by created_at limit 1));
-- Apagar a regra mantém o histórico.
delete from public.alert_rules where id = 'e1000000-0000-0000-0000-000000000004';
reset role;

do $$ begin
  if (select count(*) from public.alerts where status = 'dismissed'
      and resolved_by = '00000000-0000-0000-0000-0000000000e1') <> 1 then
    raise exception 'FALHOU: owner não conseguiu ignorar';
  end if;
  if (select count(*) from public.alerts where rule_name = 'Auto' and rule_id is null) <> 2 then
    raise exception 'FALHOU: histórico da regra apagada sumiu';
  end if;
end $$;

-- --------------------------------------------------------------- Push de alerta
insert into public.notification_subscriptions (workspace_id, user_id, channel, endpoint, config) values
  ('e0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', 'webpush', 'https://push.example/e1', '{}'),
  ('e0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e2', 'webpush', 'https://push.example/e2', '{}');
update public.notification_preferences set notify_alerts = false
where user_id = '00000000-0000-0000-0000-0000000000e2';
do $$
declare n int;
begin
  select count(*) into n
  from public.service_notification_recipients('e0000000-0000-0000-0000-000000000001', 'alert', 0, '2026-10-26 12:00:00-03');
  if n <> 1 then raise exception 'FALHOU: notify_alerts não filtrou (%)', n; end if;
end $$;

\o
select 'alert_rules_test: OK' as resultado;
rollback;
