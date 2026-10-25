-- Testes da etapa 3: inscrição de push e filtro de destinatários pelas preferências.
\set ON_ERROR_STOP 1
\o /dev/null
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000c1', 'push-a@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000c2', 'push-b@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000c3', 'intruso@teste.nishiads.dev', now());
insert into public.workspaces (id, name, timezone) values ('c0000000-0000-0000-0000-000000000001', 'WS push', 'America/Sao_Paulo');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('c0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', 'owner'),
  ('c0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c2', 'viewer');

-- Membro se inscreve; reinscrever o mesmo endpoint não duplica.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1"}', true);
select public.register_push_subscription('c0000000-0000-0000-0000-000000000001', 'https://push.example/a',
  repeat('A', 87), repeat('B', 22), 'Teste A');
select public.register_push_subscription('c0000000-0000-0000-0000-000000000001', 'https://push.example/a',
  repeat('C', 87), repeat('D', 22), 'Teste A2');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2"}', true);
select public.register_push_subscription('c0000000-0000-0000-0000-000000000001', 'https://push.example/b',
  repeat('A', 87), repeat('B', 22), null);

-- Quem não é membro não se inscreve.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c3"}', true);
do $$ begin
  begin
    perform public.register_push_subscription('c0000000-0000-0000-0000-000000000001', 'https://push.example/x',
      repeat('A', 87), repeat('B', 22), null);
    raise exception 'FALHOU: não membro conseguiu se inscrever';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Ninguém autenticado chama a função de destinatários nem grava no log.
do $$ begin
  begin
    perform * from public.service_notification_recipients('c0000000-0000-0000-0000-000000000001', 'sale_approved', 100);
    raise exception 'FALHOU: authenticated chamou service_notification_recipients';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.notification_log (workspace_id, sale_id, kind)
    values ('c0000000-0000-0000-0000-000000000001', gen_random_uuid(), 'sale_approved');
    raise exception 'FALHOU: authenticated gravou em notification_log';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
declare n int;
begin
  select count(*) into n from public.notification_subscriptions where workspace_id = 'c0000000-0000-0000-0000-000000000001';
  if n <> 2 then raise exception 'FALHOU: esperava 2 inscrições, veio %', n; end if;
  if (select config ->> 'p256dh' from public.notification_subscriptions where endpoint = 'https://push.example/a') <> repeat('C', 87) then
    raise exception 'FALHOU: reinscrição não atualizou as chaves';
  end if;
end $$;

-- Preferências: B só quer vendas acima de R$ 100 e silêncio das 22h às 7h; A não quer reembolso.
update public.notification_preferences set min_amount_cents = 10000, quiet_hours_start = '22:00', quiet_hours_end = '07:00'
where user_id = '00000000-0000-0000-0000-0000000000c2';
update public.notification_preferences set notify_refunded = false
where user_id = '00000000-0000-0000-0000-0000000000c1';

do $$
declare
  ws uuid := 'c0000000-0000-0000-0000-000000000001';
  noon timestamptz := '2026-10-25 12:00:00-03';
  night timestamptz := '2026-10-25 23:30:00-03';
  early timestamptz := '2026-10-26 06:59:00-03';
  n int;
begin
  select count(*) into n from public.service_notification_recipients(ws, 'sale_approved', 19700, noon);
  if n <> 2 then raise exception 'FALHOU: venda de R$ 197 ao meio-dia deveria ir para 2, foi %', n; end if;
  select count(*) into n from public.service_notification_recipients(ws, 'sale_approved', 4700, noon);
  if n <> 1 then raise exception 'FALHOU: valor mínimo não filtrou (%)', n; end if;
  select count(*) into n from public.service_notification_recipients(ws, 'sale_approved', 19700, night);
  if n <> 1 then raise exception 'FALHOU: silêncio 22h–7h não filtrou às 23h30 (%)', n; end if;
  select count(*) into n from public.service_notification_recipients(ws, 'sale_approved', 19700, early);
  if n <> 1 then raise exception 'FALHOU: silêncio 22h–7h não filtrou às 6h59 (%)', n; end if;
  select count(*) into n from public.service_notification_recipients(ws, 'sale_refunded', 19700, noon);
  if n <> 1 then raise exception 'FALHOU: notify_refunded=false não filtrou (%)', n; end if;
  -- Valor mínimo não vale para reembolso.
  if not exists (select 1 from public.service_notification_recipients(ws, 'sale_refunded', 100, noon)
                 where user_id = '00000000-0000-0000-0000-0000000000c2') then
    raise exception 'FALHOU: valor mínimo bloqueou reembolso';
  end if;
  update public.notification_subscriptions set active = false where endpoint = 'https://push.example/a';
  select count(*) into n from public.service_notification_recipients(ws, 'sale_approved', 19700, noon);
  if n <> 1 then raise exception 'FALHOU: inscrição inativa recebeu (%)', n; end if;
end $$;

-- notification_log: uma linha por venda e tipo.
insert into public.sales (id, workspace_id, provider, external_order_id, status, gross_amount_cents)
values ('c5000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'kiwify', 'push-1', 'approved', 19700);
insert into public.notification_log (workspace_id, sale_id, kind)
values ('c0000000-0000-0000-0000-000000000001', 'c5000000-0000-0000-0000-000000000001', 'sale_approved');
do $$ begin
  begin
    insert into public.notification_log (workspace_id, sale_id, kind)
    values ('c0000000-0000-0000-0000-000000000001', 'c5000000-0000-0000-0000-000000000001', 'sale_approved');
    raise exception 'FALHOU: notification_log aceitou duplicata';
  exception when unique_violation then null;
  end;
end $$;

\o
select 'web_push_test: OK' as resultado;
rollback;
