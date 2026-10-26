-- Testes da Conversions API: configuração (token no Vault), fila pelo trigger de vendas,
-- reembolso, backfill, reserva de eventos e permissões.
\set ON_ERROR_STOP 1
\o /dev/null
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'capi-owner@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000e2', 'capi-viewer@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000e3', 'capi-intruso@teste.nishiads.dev', now());
insert into public.workspaces (id, name) values
  ('e0000000-0000-0000-0000-000000000001', 'WS capi'),
  ('e0000000-0000-0000-0000-000000000002', 'WS outro');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('e0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', 'owner'),
  ('e0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e2', 'viewer'),
  ('e0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000e3', 'owner');

-- Venda antes de configurar: não entra na fila.
set local role service_role;
select public.service_ingest_sale('e0000000-0000-0000-0000-000000000001', null, 'stripe', jsonb_build_object(
  'external_order_id', 'pi_antes', 'status', 'approved', 'gross_amount_cents', 9700,
  'paid_at', now() - interval '2 days'));
reset role;

-- Viewer e intruso não configuram.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2"}', true);
do $$ begin
  begin
    perform public.save_meta_capi_config('e0000000-0000-0000-0000-000000000001', '1234567890123', 'https://site.com', repeat('A', 120));
    raise exception 'FALHOU: viewer salvou a configuração';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e3"}', true);
do $$ begin
  begin
    perform public.save_meta_capi_config('e0000000-0000-0000-0000-000000000001', '1234567890123', 'https://site.com', repeat('A', 120));
    raise exception 'FALHOU: membro de outro workspace salvou a configuração';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Owner: validações e criação.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1"}', true);
do $$ begin
  begin
    perform public.save_meta_capi_config('e0000000-0000-0000-0000-000000000001', '1234567890123', 'https://site.com');
    raise exception 'FALHOU: criou configuração sem token';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.save_meta_capi_config('e0000000-0000-0000-0000-000000000001', 'abc', 'https://site.com', repeat('A', 120));
    raise exception 'FALHOU: aceitou pixel inválido';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.save_meta_capi_config('e0000000-0000-0000-0000-000000000001', '1234567890123', 'site.com', repeat('A', 120));
    raise exception 'FALHOU: aceitou URL sem https';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.save_meta_capi_config('e0000000-0000-0000-0000-000000000001', '1234567890123', 'https://site.com', 'curto');
    raise exception 'FALHOU: aceitou token curto';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.save_meta_capi_config('e0000000-0000-0000-0000-000000000001', '1234567890123', 'https://site.com', repeat('A', 120), 'TEST 1');
    raise exception 'FALHOU: aceitou código de teste inválido';
  exception when invalid_parameter_value then null;
  end;
end $$;
select public.save_meta_capi_config('e0000000-0000-0000-0000-000000000001', ' 1234567890123 ', 'https://site.com/obrigado',
  'EAAB' || repeat('a', 100), 'TEST123', true, true, true);

-- O app vê has_token, mas não token_ref.
do $$ begin
  if not (select has_token from public.meta_capi_configs where workspace_id = 'e0000000-0000-0000-0000-000000000001') then
    raise exception 'FALHOU: has_token';
  end if;
  begin
    perform token_ref from public.meta_capi_configs;
    raise exception 'FALHOU: authenticated leu token_ref';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.meta_capi_events (workspace_id, event_name, event_id, event_time)
    values ('e0000000-0000-0000-0000-000000000001', 'Purchase', 'x', now());
    raise exception 'FALHOU: authenticated escreveu na fila';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.service_meta_capi_credentials('e0000000-0000-0000-0000-000000000001');
    raise exception 'FALHOU: authenticated leu o token';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Trocar só a URL mantém o token; trocar o token apaga o anterior do Vault.
do $$
declare v_ref uuid; v_ref2 uuid;
begin
  select token_ref into v_ref from public.meta_capi_configs where workspace_id = 'e0000000-0000-0000-0000-000000000001';
  if (select pixel_id from public.meta_capi_configs where workspace_id = 'e0000000-0000-0000-0000-000000000001') <> '1234567890123' then
    raise exception 'FALHOU: pixel não foi limpo';
  end if;
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1"}', true);
  perform public.save_meta_capi_config('e0000000-0000-0000-0000-000000000001', '1234567890123', 'https://site.com/',
    null, 'TEST123', true, true, true);
  select token_ref into v_ref2 from public.meta_capi_configs where workspace_id = 'e0000000-0000-0000-0000-000000000001';
  if v_ref2 is distinct from v_ref then raise exception 'FALHOU: salvar sem token trocou o token'; end if;
  perform public.save_meta_capi_config('e0000000-0000-0000-0000-000000000001', '1234567890123', 'https://site.com/',
    'EAAB' || repeat('b', 100), 'TEST123', true, true, true);
  if exists (select 1 from vault.secrets where id = v_ref) then raise exception 'FALHOU: token antigo ficou no Vault'; end if;
  if (select access_token from public.service_meta_capi_credentials('e0000000-0000-0000-0000-000000000001'))
     <> 'EAAB' || repeat('b', 100) then
    raise exception 'FALHOU: credenciais';
  end if;
end $$;

set local role service_role;
do $$
declare r jsonb; v_count int; v_claimed int;
begin
  -- Venda aprovada → Purchase com o id do pedido; retry do webhook não duplica.
  r := public.service_ingest_sale('e0000000-0000-0000-0000-000000000001', null, 'stripe', jsonb_build_object(
    'external_order_id', 'pi_1', 'status', 'approved', 'gross_amount_cents', 9700, 'paid_at', now() - interval '1 minute',
    'fbc', 'fb.1.1700000000000.IwAR-abc', 'fbp', 'fb.1.1700000000000.123456789', 'client_user_agent', 'Mozilla/5.0'));
  r := public.service_ingest_sale('e0000000-0000-0000-0000-000000000001', null, 'stripe', jsonb_build_object(
    'external_order_id', 'pi_1', 'status', 'approved', 'gross_amount_cents', 9700));
  select count(*) into v_count from public.meta_capi_events where event_id = 'pi_1';
  if v_count <> 1 then raise exception 'FALHOU: Purchase duplicado ou ausente (%)', v_count; end if;
  if (select event_name from public.meta_capi_events where event_id = 'pi_1') <> 'Purchase' then
    raise exception 'FALHOU: evento da venda não é Purchase';
  end if;
  if (select fbc || '/' || fbp || '/' || client_user_agent from public.sales where external_order_id = 'pi_1')
     <> 'fb.1.1700000000000.IwAR-abc/fb.1.1700000000000.123456789/Mozilla/5.0' then
    raise exception 'FALHOU: dados de clique não foram gravados';
  end if;

  -- fbc/fbp fora do formato não derrubam a venda.
  r := public.service_ingest_sale('e0000000-0000-0000-0000-000000000001', null, 'stripe', jsonb_build_object(
    'external_order_id', 'pi_2', 'status', 'pending', 'gross_amount_cents', 9700, 'fbc', 'lixo', 'fbp', 'fb.1.abc'));
  if (select coalesce(fbc, '') || coalesce(fbp, '') from public.sales where external_order_id = 'pi_2') <> '' then
    raise exception 'FALHOU: fbc/fbp inválidos foram gravados';
  end if;
  if exists (select 1 from public.meta_capi_events where event_id = 'pi_2') then
    raise exception 'FALHOU: venda pendente entrou na fila';
  end if;
  -- Pendente → aprovada entra na fila; reembolso antes do envio cancela.
  r := public.service_ingest_sale('e0000000-0000-0000-0000-000000000001', null, 'stripe', jsonb_build_object(
    'external_order_id', 'pi_2', 'status', 'approved', 'gross_amount_cents', 9700, 'paid_at', now()));
  r := public.service_ingest_sale('e0000000-0000-0000-0000-000000000001', null, 'stripe', jsonb_build_object(
    'external_order_id', 'pi_2', 'status', 'refunded', 'gross_amount_cents', 9700, 'refunded_at', now()));
  if (select status::text from public.meta_capi_events where event_id = 'pi_2' and event_name = 'Purchase') <> 'skipped' then
    raise exception 'FALHOU: reembolso antes do envio não cancelou o Purchase';
  end if;
  if exists (select 1 from public.meta_capi_events where event_id = 'pi_2' and event_name = 'Refund') then
    raise exception 'FALHOU: Refund de um Purchase que não foi enviado';
  end if;

  -- Reembolso depois do envio → Refund (send_refunds ligado).
  update public.meta_capi_events set status = 'sent', sent_at = now() where event_id = 'pi_1';
  r := public.service_ingest_sale('e0000000-0000-0000-0000-000000000001', null, 'stripe', jsonb_build_object(
    'external_order_id', 'pi_1', 'status', 'refunded', 'gross_amount_cents', 9700, 'refunded_at', now()));
  if not exists (select 1 from public.meta_capi_events where event_id = 'pi_1' and event_name = 'Refund' and status = 'pending') then
    raise exception 'FALHOU: Refund não entrou na fila';
  end if;
  if (select status::text from public.meta_capi_events where event_id = 'pi_1' and event_name = 'Purchase') <> 'sent' then
    raise exception 'FALHOU: reembolso mexeu no Purchase já enviado';
  end if;

  -- Teste iniciado → StartTrial; conversão → Purchase da cobrança e herda fbc do teste.
  r := public.service_ingest_sale('e0000000-0000-0000-0000-000000000001', null, 'stripe', jsonb_build_object(
    'external_order_id', 'sub_1', 'subscription_ref', 'sub_1', 'status', 'trialing', 'gross_amount_cents', 0,
    'fbc', 'fb.1.1700000000000.TRIAL'));
  if not exists (select 1 from public.meta_capi_events where event_id = 'sub_1' and event_name = 'StartTrial') then
    raise exception 'FALHOU: StartTrial não entrou na fila';
  end if;
  r := public.service_ingest_sale('e0000000-0000-0000-0000-000000000001', null, 'stripe', jsonb_build_object(
    'external_order_id', 'pi_3', 'subscription_ref', 'sub_1', 'status', 'approved', 'gross_amount_cents', 4990,
    'paid_at', now()));
  if not exists (select 1 from public.meta_capi_events where event_id = 'pi_3' and event_name = 'Purchase') then
    raise exception 'FALHOU: conversão do teste não gerou Purchase';
  end if;
  if (select fbc from public.sales where external_order_id = 'pi_3') <> 'fb.1.1700000000000.TRIAL' then
    raise exception 'FALHOU: venda não herdou o fbc do teste';
  end if;

  -- Data futura vira agora.
  if (select event_time from public.meta_capi_events where event_id = 'pi_3') > now() then
    raise exception 'FALHOU: event_time no futuro';
  end if;

  -- Reserva: cada evento uma vez por vez; por venda; depois do lock vencido, de novo.
  select count(*) into v_claimed from public.service_claim_meta_capi_events(50,
    (select id from public.sales where external_order_id = 'pi_3'));
  if v_claimed <> 1 then raise exception 'FALHOU: reserva por venda (%)', v_claimed; end if;
  select count(*) into v_claimed from public.service_claim_meta_capi_events(50,
    (select id from public.sales where external_order_id = 'pi_3'));
  if v_claimed <> 0 then raise exception 'FALHOU: evento reservado duas vezes'; end if;
  update public.meta_capi_events set locked_until = now() - interval '1 second' where event_id = 'pi_3';
  select count(*) into v_claimed from public.service_claim_meta_capi_events(50,
    (select id from public.sales where external_order_id = 'pi_3'));
  if v_claimed <> 1 then raise exception 'FALHOU: lock vencido não foi retomado'; end if;

  -- Integração pausada: nada é reservado nem entra na fila.
  update public.meta_capi_configs set enabled = false where workspace_id = 'e0000000-0000-0000-0000-000000000001';
  update public.meta_capi_events set locked_until = null where status = 'pending';
  select count(*) into v_claimed from public.service_claim_meta_capi_events(50);
  if v_claimed <> 0 then raise exception 'FALHOU: reservou evento com a integração pausada'; end if;
  r := public.service_ingest_sale('e0000000-0000-0000-0000-000000000001', null, 'stripe', jsonb_build_object(
    'external_order_id', 'pi_4', 'status', 'approved', 'gross_amount_cents', 100, 'paid_at', now()));
  if exists (select 1 from public.meta_capi_events where event_id = 'pi_4') then
    raise exception 'FALHOU: venda entrou na fila com a integração pausada';
  end if;
  update public.meta_capi_configs set enabled = true where workspace_id = 'e0000000-0000-0000-0000-000000000001';

  -- Outro workspace sem configuração: nada na fila.
  r := public.service_ingest_sale('e0000000-0000-0000-0000-000000000002', null, 'stripe', jsonb_build_object(
    'external_order_id', 'pi_x', 'status', 'approved', 'gross_amount_cents', 100, 'paid_at', now()));
  if exists (select 1 from public.meta_capi_events where workspace_id = 'e0000000-0000-0000-0000-000000000002') then
    raise exception 'FALHOU: workspace sem configuração entrou na fila';
  end if;
end $$;
reset role;

-- Backfill: só aprovadas dos últimos 7 dias que ainda não estão na fila; viewer não chama.
update public.sales set paid_at = now() - interval '10 days' where external_order_id = 'pi_x';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2"}', true);
do $$ begin
  begin
    perform public.enqueue_meta_capi_backfill('e0000000-0000-0000-0000-000000000001');
    raise exception 'FALHOU: viewer fez backfill';
  exception when insufficient_privilege then null;
  end;
  -- Viewer lê a configuração, mas não a fila.
  if not exists (select 1 from public.meta_capi_configs) then raise exception 'FALHOU: viewer não lê a configuração'; end if;
  if exists (select 1 from public.meta_capi_events) then raise exception 'FALHOU: viewer leu a fila'; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1"}', true);
do $$
declare n int;
begin
  n := public.enqueue_meta_capi_backfill('e0000000-0000-0000-0000-000000000001');
  -- pi_antes (2 dias) e pi_4 (pausada) entram; pi_1/pi_2 viraram reembolso; pi_3 já estava.
  if n <> 2 then raise exception 'FALHOU: backfill colocou % eventos (esperado 2)', n; end if;
  if public.enqueue_meta_capi_backfill('e0000000-0000-0000-0000-000000000001') <> 0 then
    raise exception 'FALHOU: backfill não é idempotente';
  end if;
  if (select count(*) from public.meta_capi_events) < 5 then raise exception 'FALHOU: owner não lê a fila'; end if;

  -- Reenviar: só evento com falha.
  begin
    perform public.retry_meta_capi_event((select id from public.meta_capi_events where event_id = 'pi_1' and event_name = 'Purchase'));
    raise exception 'FALHOU: reenviou evento já enviado';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;
update public.meta_capi_events set status = 'failed', next_attempt_at = now() + interval '1 day'
where event_id = 'pi_antes';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1"}', true);
select public.retry_meta_capi_event((select id from public.meta_capi_events where event_id = 'pi_antes'));
-- Desconectar: pendentes não vão mais e o token sai do Vault.
select public.delete_meta_capi_config('e0000000-0000-0000-0000-000000000001');
reset role;

do $$ begin
  if exists (select 1 from public.meta_capi_configs) then raise exception 'FALHOU: configuração não foi apagada'; end if;
  if exists (select 1 from vault.secrets where description like 'meta-capi:%') then
    raise exception 'FALHOU: token ficou no Vault depois de desconectar';
  end if;
  if exists (select 1 from public.meta_capi_events where status = 'pending') then
    raise exception 'FALHOU: ficaram eventos pendentes depois de desconectar';
  end if;
end $$;

rollback;
\o
\echo 'meta_capi_test: ok'
