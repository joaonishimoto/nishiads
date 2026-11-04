-- Nishiads · Regras de alerta contam os testes iniciados como venda.
--
-- Uma assinatura com período de teste entra em sales como trialing, com valor zero.
-- Até aqui as regras só olhavam vendas aprovadas: em um produto vendido por teste
-- grátis, "gastou sem vender" disparava em todo anúncio (inclusive nos que mais
-- trazem testes) e o CPA nunca existia. Agora o teste em andamento conta como uma
-- venda de valor zero, igual ao painel: "sem venda" vira "sem venda nem teste" e o
-- CPA vira o custo por teste. O teste já convertido não conta, porque a venda
-- aprovada em que ele virou já conta. ROAS não muda: o teste não tem receita.

create or replace function private.alert_rule_matches(
  p_workspace_id uuid,
  p_condition text,
  p_level text,
  p_time_window text,
  p_threshold_cents bigint,
  p_min_roas numeric,
  p_min_spend_cents bigint,
  p_ad_account_id uuid,
  p_campaign_id uuid,
  p_now timestamptz default now()
)
returns table (
  object_id uuid,
  ad_account_id uuid,
  object_external_id text,
  object_name text,
  currency char(3),
  spend_cents bigint,
  sales integer,
  revenue_cents bigint,
  roas numeric,
  cpa_cents bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select
      w.currency,
      w.timezone,
      (p_now at time zone w.timezone)::date
        - case p_time_window when 'last_3d' then 2 when 'last_7d' then 6 else 0 end as first_day,
      (p_now at time zone w.timezone)::date as last_day
    from public.workspaces w
    where w.id = p_workspace_id
  ),
  objects as (
    select c.id, c.ad_account_id, c.external_id, c.name
    from public.campaigns c
    where p_level = 'campaign' and c.workspace_id = p_workspace_id and c.effective_status = 'ACTIVE'
      and (p_ad_account_id is null or c.ad_account_id = p_ad_account_id)
      and (p_campaign_id is null or c.id = p_campaign_id)
    union all
    select s.id, s.ad_account_id, s.external_id, s.name
    from public.adsets s
    where p_level = 'adset' and s.workspace_id = p_workspace_id and s.effective_status = 'ACTIVE'
      and (p_ad_account_id is null or s.ad_account_id = p_ad_account_id)
      and (p_campaign_id is null or s.campaign_id = p_campaign_id)
    union all
    select a.id, a.ad_account_id, a.external_id, a.name
    from public.ads a
    where p_level = 'ad' and a.workspace_id = p_workspace_id and a.effective_status = 'ACTIVE'
      and (p_ad_account_id is null or a.ad_account_id = p_ad_account_id)
      and (p_campaign_id is null or a.campaign_id = p_campaign_id)
  ),
  spend as (
    select
      case p_level when 'campaign' then a.campaign_id when 'adset' then a.adset_id else a.id end as object_id,
      sum(i.spend_cents)::bigint as spend_cents
    from public.ad_insights_daily i
    join public.ads a on a.id = i.ad_id
    cross join bounds b
    where i.workspace_id = p_workspace_id
      and i.date between b.first_day and b.last_day
      and i.currency = b.currency
    group by 1
  ),
  sold as (
    select
      case p_level when 'campaign' then s.campaign_id when 'adset' then s.adset_id else s.ad_id end as object_id,
      count(*)::integer as sales,
      sum(s.gross_amount_cents)::bigint as revenue_cents
    from public.sales s
    cross join bounds b
    where s.workspace_id = p_workspace_id
      -- Venda aprovada, ou teste ainda em andamento (o convertido já virou venda aprovada).
      and (s.status = 'approved'
        or (s.status::text = 'trialing' and s.converted_sale_id is null))
      and s.currency = b.currency
      and coalesce(s.paid_at, s.created_at) >= (b.first_day::timestamp at time zone b.timezone)
      and coalesce(s.paid_at, s.created_at) < ((b.last_day + 1)::timestamp at time zone b.timezone)
    group by 1
  ),
  numbers as (
    select
      o.id as object_id,
      o.ad_account_id,
      o.external_id as object_external_id,
      o.name as object_name,
      b.currency,
      sp.spend_cents,
      coalesce(so.sales, 0) as sales,
      coalesce(so.revenue_cents, 0)::bigint as revenue_cents
    from objects o
    join spend sp on sp.object_id = o.id
    left join sold so on so.object_id = o.id
    cross join bounds b
    where sp.spend_cents > 0
  )
  select
    n.object_id,
    n.ad_account_id,
    n.object_external_id,
    n.object_name,
    n.currency,
    n.spend_cents,
    n.sales,
    n.revenue_cents,
    round(n.revenue_cents::numeric / n.spend_cents, 4) as roas,
    case when n.sales > 0 then round(n.spend_cents::numeric / n.sales)::bigint end as cpa_cents
  from numbers n
  where case p_condition
      when 'spend_without_sale' then n.sales = 0 and n.spend_cents >= p_threshold_cents
      when 'roas_below' then n.spend_cents >= greatest(p_min_spend_cents, 1)
        and n.revenue_cents::numeric / n.spend_cents < p_min_roas
      when 'cpa_above' then n.spend_cents >= greatest(p_min_spend_cents, 1)
        and n.spend_cents > p_threshold_cents * greatest(n.sales, 1)
      else false
    end
  order by n.spend_cents desc, n.object_id;
$$;
