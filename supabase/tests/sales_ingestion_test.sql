-- Testes da etapa 2: upsert idempotente de vendas, ordem de status e atribuição por UTM.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/sales_ingestion_test.sql

\set ON_ERROR_STOP 1
\o /dev/null
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'viewer@teste.nishiads.dev', now());

insert into public.workspaces (id, name) values ('a0000000-0000-0000-0000-000000000001', 'WS vendas');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', 'viewer');

insert into public.ad_accounts (id, workspace_id, external_id, name)
values ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'act_1', 'Conta');
insert into public.campaigns (id, workspace_id, ad_account_id, external_id, name) values
  ('a2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', '1202000001', 'Black Friday'),
  ('a2000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', '1202000002', 'Remarketing');
insert into public.adsets (id, workspace_id, ad_account_id, campaign_id, external_id, name) values
  ('a3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', '1203000001', 'Lookalike 1%'),
  ('a3000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000002', '1203000002', 'Lookalike 1%');
insert into public.ads (id, workspace_id, ad_account_id, campaign_id, adset_id, external_id, name) values
  ('a4000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', '1204000001', 'Vídeo depoimento'),
  ('a4000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000002', '1204000002', 'Vídeo depoimento');

do $$ begin
  if (select ref_name || '/' || ref_id from private.split_utm_ref('Black Friday | Topo|1202000001')) <> 'Black Friday | Topo/1202000001' then
    raise exception 'FALHOU: split_utm_ref com "|" no nome';
  end if;
  if (select coalesce(ref_name, '-') || '/' || ref_id from private.split_utm_ref('1202000001')) <> '-/1202000001' then
    raise exception 'FALHOU: split_utm_ref só com id';
  end if;
  if (select ref_name || '/' || coalesce(ref_id, '-') from private.split_utm_ref('Black Friday')) <> 'Black Friday/-' then
    raise exception 'FALHOU: split_utm_ref só com nome';
  end if;
end $$;

set local role service_role;

do $$
declare r jsonb; v_count int;
begin
  -- 1. UTMs completos com ids → matched.
  r := public.service_ingest_sale('a0000000-0000-0000-0000-000000000001', null, 'kiwify', jsonb_build_object(
    'external_order_id', 'K-1', 'status', 'approved', 'gross_amount_cents', 19700, 'net_amount_cents', 17500,
    'external_product_id', 'prod-1', 'product_name', 'Curso X',
    'utm_source', 'FB', 'utm_campaign', 'Black Friday|1202000001', 'utm_medium', 'Lookalike 1%|1203000001',
    'utm_content', 'Vídeo depoimento|1204000001', 'utm_term', 'Instagram_Reels', 'paid_at', '2026-10-25T12:00:00-03:00'));
  if r->>'attribution_status' <> 'matched' or (r->>'inserted')::boolean is not true then
    raise exception 'FALHOU: venda com ids deveria ser matched e nova: %', r;
  end if;
  if (select ad_id::text || adset_id::text || campaign_id::text from public.sales where external_order_id = 'K-1')
     <> 'a4000000-0000-0000-0000-000000000001a3000000-0000-0000-0000-000000000001a2000000-0000-0000-0000-000000000001' then
    raise exception 'FALHOU: hierarquia da venda K-1';
  end if;
  if (select count(*) from public.products where external_product_id = 'prod-1') <> 1 then
    raise exception 'FALHOU: produto não foi criado';
  end if;

  -- 2. Mesmo pedido de novo (retry do provedor) → nenhum duplicado.
  r := public.service_ingest_sale('a0000000-0000-0000-0000-000000000001', null, 'kiwify', jsonb_build_object(
    'external_order_id', 'K-1', 'status', 'approved', 'gross_amount_cents', 19700, 'external_product_id', 'prod-1'));
  select count(*) into v_count from public.sales where external_order_id = 'K-1';
  if v_count <> 1 or (r->>'inserted')::boolean or r->>'previous_status' <> 'approved' then
    raise exception 'FALHOU: idempotência (% vendas, %)', v_count, r;
  end if;
  if (select utm_campaign from public.sales where external_order_id = 'K-1') is null then
    raise exception 'FALHOU: retry sem UTMs apagou os UTMs';
  end if;

  -- 3. Reembolso atualiza; aprovação atrasada não desfaz o reembolso.
  r := public.service_ingest_sale('a0000000-0000-0000-0000-000000000001', null, 'kiwify', jsonb_build_object(
    'external_order_id', 'K-1', 'status', 'refunded', 'gross_amount_cents', 19700, 'refunded_at', now()));
  r := public.service_ingest_sale('a0000000-0000-0000-0000-000000000001', null, 'kiwify', jsonb_build_object(
    'external_order_id', 'K-1', 'status', 'approved', 'gross_amount_cents', 19700));
  if (select status from public.sales where external_order_id = 'K-1') <> 'refunded' then
    raise exception 'FALHOU: aprovação atrasada desfez o reembolso';
  end if;

  -- 4. Sem UTMs → unattributed.
  r := public.service_ingest_sale('a0000000-0000-0000-0000-000000000001', null, 'kiwify', jsonb_build_object(
    'external_order_id', 'K-2', 'status', 'approved', 'gross_amount_cents', 9700));
  if r->>'attribution_status' <> 'unattributed' then raise exception 'FALHOU: venda sem UTM: %', r; end if;

  -- 5. Só nomes: "Lookalike 1%" e "Vídeo depoimento" existem nas duas campanhas; a campanha desambigua.
  r := public.service_ingest_sale('a0000000-0000-0000-0000-000000000001', null, 'kiwify', jsonb_build_object(
    'external_order_id', 'K-3', 'status', 'approved', 'gross_amount_cents', 9700,
    'utm_campaign', 'remarketing', 'utm_medium', 'Lookalike 1%', 'utm_content', 'Vídeo depoimento'));
  if r->>'attribution_status' <> 'matched'
     or (select ad_id from public.sales where external_order_id = 'K-3') <> 'a4000000-0000-0000-0000-000000000002' then
    raise exception 'FALHOU: casamento por nome dentro da campanha: %', r;
  end if;

  -- 6. Nome ambíguo sem campanha → partial (não chuta).
  r := public.service_ingest_sale('a0000000-0000-0000-0000-000000000001', null, 'kiwify', jsonb_build_object(
    'external_order_id', 'K-4', 'status', 'approved', 'gross_amount_cents', 9700, 'utm_content', 'Vídeo depoimento'));
  if r->>'attribution_status' <> 'partial' then raise exception 'FALHOU: nome ambíguo deveria ser partial: %', r; end if;

  -- 7. Ids ainda não sincronizados → partial; depois da sincronização → matched.
  r := public.service_ingest_sale('a0000000-0000-0000-0000-000000000001', null, 'kiwify', jsonb_build_object(
    'external_order_id', 'K-5', 'status', 'approved', 'gross_amount_cents', 9700,
    'utm_campaign', 'Nova|1202000009', 'utm_medium', 'Aberto|1203000009', 'utm_content', 'Carrossel|1204000009'));
  if r->>'attribution_status' <> 'partial' then raise exception 'FALHOU: ids desconhecidos: %', r; end if;
end $$;

insert into public.campaigns (id, workspace_id, ad_account_id, external_id, name)
values ('a2000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', '1202000009', 'Nova');
insert into public.adsets (id, workspace_id, ad_account_id, campaign_id, external_id, name)
values ('a3000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000009', '1203000009', 'Aberto');
insert into public.ads (id, workspace_id, ad_account_id, campaign_id, adset_id, external_id, name)
values ('a4000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000009', 'a3000000-0000-0000-0000-000000000009', '1204000009', 'Carrossel');

do $$ begin
  if public.service_reattribute_sales('a0000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'FALHOU: reatribuição deveria casar 1 venda (K-5)';
  end if;
  if (select attribution_status from public.sales where external_order_id = 'K-5') <> 'matched' then
    raise exception 'FALHOU: K-5 não ficou matched';
  end if;
end $$;

-- App não chama a ingestão; viewer não refaz atribuição; owner refaz.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.service_ingest_sale('a0000000-0000-0000-0000-000000000001', null, 'kiwify', '{"external_order_id":"X","status":"approved","gross_amount_cents":1}');
    raise exception 'FALHOU: authenticated chamou service_ingest_sale';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.reattribute_sales('a0000000-0000-0000-0000-000000000001');
    raise exception 'FALHOU: viewer refez a atribuição';
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from public.sales) <> 5 then raise exception 'FALHOU: viewer deveria ver as 5 vendas'; end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
do $$ begin
  perform public.reattribute_sales('a0000000-0000-0000-0000-000000000001');
end $$;

\o
select 'OK: testes de ingestão e atribuição da etapa 2 passaram' as resultado;
rollback;
