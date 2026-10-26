-- Nishiads · Alertas e regras automáticas.
--
-- Uma regra (alert_rules) olha os números de hoje, dos últimos 3 ou 7 dias, no
-- fuso do workspace, em um nível (campanha, conjunto ou anúncio) ativo na Meta, e
-- dispara quando a condição bate:
--   spend_without_sale  gastou ao menos threshold_cents sem nenhuma venda aprovada
--   roas_below          ROAS abaixo de min_roas, depois de gastar min_spend_cents
--   cpa_above           CPA acima de threshold_cents (sem venda, conta o gasto todo),
--                       depois de gastar min_spend_cents
-- A ação pode ser só avisar (notify), avisar e pedir aprovação para pausar
-- (approve_pause) ou pausar sozinha (auto_pause), com um limite de pausas
-- automáticas por regra por dia; passou do limite, vira pedido de aprovação.
--
-- service_evaluate_alert_rules() roda depois de cada sincronização da Meta (Edge
-- Function meta-sync) e grava em alerts no máximo um alerta por regra, objeto e
-- dia: o mesmo anúncio não dispara de novo no mesmo dia, nem depois que alguém o
-- reativa. A Edge Function manda o push e, quando for o caso, pausa na Meta.
-- Os números são os mesmos do dashboard: vendas aprovadas na moeda do workspace,
-- atribuídas ao objeto, e gasto dos insights diários.

-- ---------------------------------------------------------------------------
-- Regras
-- ---------------------------------------------------------------------------

create table public.alert_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  enabled boolean not null default true,
  condition text not null check (condition in ('spend_without_sale', 'roas_below', 'cpa_above')),
  level text not null check (level in ('campaign', 'adset', 'ad')),
  time_window text not null default 'today' check (time_window in ('today', 'last_3d', 'last_7d')),
  threshold_cents bigint check (threshold_cents > 0 and threshold_cents <= 100000000),
  min_roas numeric(6, 2) check (min_roas > 0 and min_roas <= 100),
  min_spend_cents bigint not null default 0 check (min_spend_cents >= 0 and min_spend_cents <= 100000000),
  action text not null default 'notify' check (action in ('notify', 'approve_pause', 'auto_pause')),
  max_auto_pauses_per_day integer not null default 3 check (max_auto_pauses_per_day between 1 and 50),
  -- Escopo opcional. Apagar a conta ou a campanha apaga a regra: uma regra que
  -- pausa sozinha nunca deve passar a valer, sem aviso, para o workspace inteiro.
  ad_account_id uuid,
  campaign_id uuid,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  last_evaluated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  check ((condition = 'roas_below') = (min_roas is not null)),
  check (condition = 'roas_below' or threshold_cents is not null),
  foreign key (ad_account_id, workspace_id)
    references public.ad_accounts (id, workspace_id) on delete cascade,
  foreign key (campaign_id, workspace_id)
    references public.campaigns (id, workspace_id) on delete cascade
);

create index alert_rules_workspace_idx on public.alert_rules (workspace_id) where enabled;
create index alert_rules_ad_account_idx on public.alert_rules (ad_account_id) where ad_account_id is not null;
create index alert_rules_campaign_idx on public.alert_rules (campaign_id) where campaign_id is not null;

create trigger alert_rules_set_updated_at
before update on public.alert_rules
for each row execute function private.set_updated_at();

-- Limite de regras por workspace (a avaliação roda a cada sincronização).
create function private.alert_rules_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.alert_rules r where r.workspace_id = new.workspace_id) >= 30 then
    raise exception 'Limite de 30 regras por workspace.' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger alert_rules_limit
before insert on public.alert_rules
for each row execute function private.alert_rules_limit();

revoke all on function private.alert_rules_limit() from public;

-- ---------------------------------------------------------------------------
-- Alertas disparados
-- ---------------------------------------------------------------------------

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rule_id uuid,
  -- Cópia da regra no momento do disparo: o histórico continua legível se ela mudar ou sumir.
  rule_name text not null,
  condition text not null,
  level text not null check (level in ('campaign', 'adset', 'ad')),
  time_window text not null,
  action text not null,
  threshold_cents bigint,
  min_roas numeric(6, 2),
  ad_account_id uuid not null,
  object_id uuid not null,
  object_external_id text not null,
  object_name text not null,
  -- Dia (no fuso do workspace) em que disparou: no máximo um por regra, objeto e dia.
  period_key date not null,
  currency char(3) not null,
  spend_cents bigint not null,
  sales integer not null,
  revenue_cents bigint not null,
  roas numeric(12, 4),
  cpa_cents bigint,
  -- notified: só aviso · pending: espera aprovação · pausing: pausando na Meta
  -- paused · dismissed: ignorado · expired: pedido sem resposta em 24 h
  status text not null check (status in ('notified', 'pending', 'pausing', 'paused', 'dismissed', 'expired')),
  -- A regra pediu pausa automática (dentro do limite do dia).
  auto_action boolean not null default false,
  error text,
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  push_recipients integer not null default 0,
  push_delivered integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rule_id, object_id, period_key),
  foreign key (rule_id, workspace_id)
    references public.alert_rules (id, workspace_id) on delete set null (rule_id),
  foreign key (ad_account_id, workspace_id)
    references public.ad_accounts (id, workspace_id) on delete cascade
);

create index alerts_workspace_created_idx on public.alerts (workspace_id, created_at desc);
create index alerts_workspace_pending_idx on public.alerts (workspace_id) where status in ('pending', 'pausing');
create index alerts_ad_account_idx on public.alerts (ad_account_id);

create trigger alerts_set_updated_at
before update on public.alerts
for each row execute function private.set_updated_at();

-- Novo tipo de push nas preferências de cada membro.
alter table public.notification_preferences add column notify_alerts boolean not null default true;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.alert_rules enable row level security;
revoke all on public.alert_rules from anon, authenticated;
grant select, delete on public.alert_rules to authenticated;
grant insert (
  workspace_id, name, enabled, condition, level, time_window, threshold_cents, min_roas, min_spend_cents,
  action, max_auto_pauses_per_day, ad_account_id, campaign_id
) on public.alert_rules to authenticated;
grant update (
  name, enabled, condition, level, time_window, threshold_cents, min_roas, min_spend_cents,
  action, max_auto_pauses_per_day, ad_account_id, campaign_id
) on public.alert_rules to authenticated;
grant all on public.alert_rules to service_role;

create policy "alert_rules: membros leem"
on public.alert_rules for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

create policy "alert_rules: owner e admin criam"
on public.alert_rules for insert to authenticated
with check (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "alert_rules: owner e admin editam"
on public.alert_rules for update to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
with check (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "alert_rules: owner e admin apagam"
on public.alert_rules for delete to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

alter table public.alerts enable row level security;
-- O app só lê; ignorar passa por dismiss_alert() e aprovar pela Edge Function alerts.
revoke all on public.alerts from anon, authenticated;
grant select on public.alerts to authenticated;
grant all on public.alerts to service_role;

create policy "alerts: membros leem"
on public.alerts for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

-- ---------------------------------------------------------------------------
-- Avaliação
-- ---------------------------------------------------------------------------

-- Objetos ativos do nível que batem com a condição agora, com os números da janela.
create function private.alert_rule_matches(
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
      and s.status = 'approved'
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

-- Avalia as regras ligadas do workspace e devolve só os alertas novos. Antes,
-- encerra os pedidos de aprovação com mais de 24 h e solta pausas travadas
-- (execução que morreu no meio) para que voltem a pedir aprovação.
create function public.service_evaluate_alert_rules(p_workspace_id uuid, p_now timestamptz default now())
returns setof public.alerts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_rule public.alert_rules;
  v_match record;
  v_used integer;
  v_status text;
  v_alert public.alerts;
begin
  select (p_now at time zone w.timezone)::date into v_today from public.workspaces w where w.id = p_workspace_id;
  if v_today is null then
    return;
  end if;

  update public.alerts a
  set status = 'expired', resolved_at = p_now
  where a.workspace_id = p_workspace_id and a.status = 'pending' and a.created_at < p_now - interval '24 hours';

  update public.alerts a
  set status = 'pending', error = coalesce(a.error, 'A pausa não terminou. Tente de novo.')
  where a.workspace_id = p_workspace_id and a.status = 'pausing' and a.updated_at < p_now - interval '5 minutes';

  for v_rule in
    select * from public.alert_rules r
    where r.workspace_id = p_workspace_id and r.enabled
    order by r.created_at, r.id
    -- Duas avaliações ao mesmo tempo (cron e botão) não passam do limite de pausas.
    for update
  loop
    select count(*) into v_used
    from public.alerts a
    where a.rule_id = v_rule.id and a.period_key = v_today and a.auto_action;

    for v_match in
      select * from private.alert_rule_matches(
        p_workspace_id, v_rule.condition, v_rule.level, v_rule.time_window, v_rule.threshold_cents,
        v_rule.min_roas, v_rule.min_spend_cents, v_rule.ad_account_id, v_rule.campaign_id, p_now
      )
    loop
      v_status := case v_rule.action
        when 'notify' then 'notified'
        when 'approve_pause' then 'pending'
        else case when v_used < v_rule.max_auto_pauses_per_day then 'pausing' else 'pending' end
      end;

      insert into public.alerts (
        workspace_id, rule_id, rule_name, condition, level, time_window, action, threshold_cents, min_roas,
        ad_account_id, object_id, object_external_id, object_name, period_key, currency,
        spend_cents, sales, revenue_cents, roas, cpa_cents, status, auto_action, error
      )
      values (
        p_workspace_id, v_rule.id, v_rule.name, v_rule.condition, v_rule.level, v_rule.time_window, v_rule.action,
        v_rule.threshold_cents, v_rule.min_roas, v_match.ad_account_id, v_match.object_id,
        v_match.object_external_id, v_match.object_name, v_today, v_match.currency,
        v_match.spend_cents, v_match.sales, v_match.revenue_cents, v_match.roas, v_match.cpa_cents,
        v_status, v_status = 'pausing',
        case when v_rule.action = 'auto_pause' and v_status = 'pending'
          then 'Limite de pausas automáticas do dia atingido. Aprove para pausar.' end
      )
      on conflict (rule_id, object_id, period_key) do nothing
      returning * into v_alert;

      if found then
        if v_alert.auto_action then
          v_used := v_used + 1;
        end if;
        return next v_alert;
      end if;
    end loop;

    update public.alert_rules r set last_evaluated_at = p_now where r.id = v_rule.id;
  end loop;
end;
$$;

-- Prévia da regra no formulário (antes de salvar): o que dispararia agora.
create function public.preview_alert_rule(
  p_workspace_id uuid,
  p_condition text,
  p_level text,
  p_time_window text,
  p_threshold_cents bigint,
  p_min_roas numeric,
  p_min_spend_cents bigint,
  p_ad_account_id uuid default null,
  p_campaign_id uuid default null
)
returns table (
  object_id uuid,
  object_name text,
  spend_cents bigint,
  sales integer,
  revenue_cents bigint,
  roas numeric,
  cpa_cents bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Faça login para continuar.' using errcode = '28000';
  end if;
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Você não tem acesso a este workspace.' using errcode = '42501';
  end if;
  return query
  select m.object_id, m.object_name, m.spend_cents, m.sales, m.revenue_cents, m.roas, m.cpa_cents
  from private.alert_rule_matches(
    p_workspace_id, p_condition, p_level, p_time_window, p_threshold_cents, p_min_roas,
    coalesce(p_min_spend_cents, 0), p_ad_account_id, p_campaign_id
  ) m
  limit 50;
end;
$$;

-- Ignorar um alerta (owner e admin). Só pedidos em aberto mudam.
create function public.dismiss_alert(p_alert_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select a.workspace_id into v_workspace_id from public.alerts a where a.id = p_alert_id;
  if v_workspace_id is null then
    raise exception 'Alerta não encontrado.' using errcode = 'P0002';
  end if;
  perform private.require_role(v_workspace_id, array['owner', 'admin']::public.workspace_role[]);

  update public.alerts a
  set status = 'dismissed', resolved_by = (select auth.uid()), resolved_at = now()
  where a.id = p_alert_id and a.status in ('pending', 'notified');
end;
$$;

-- Push de alerta respeita a nova preferência notify_alerts (e o horário de silêncio).
create or replace function public.service_notification_recipients(
  p_workspace_id uuid,
  p_kind text,
  p_amount_cents bigint,
  p_at timestamptz default now()
)
returns table (subscription_id uuid, user_id uuid, endpoint text, config jsonb, sound_enabled boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with local_now as (
    select (p_at at time zone w.timezone)::time as t
    from public.workspaces w
    where w.id = p_workspace_id
  )
  select s.id, s.user_id, s.endpoint, s.config, p.sound_enabled
  from public.notification_subscriptions s
  join public.notification_preferences p
    on p.workspace_id = s.workspace_id and p.user_id = s.user_id
  cross join local_now n
  where s.workspace_id = p_workspace_id
    and s.channel = 'webpush'
    and s.active
    and case p_kind
          when 'sale_approved' then p.notify_approved and p_amount_cents >= p.min_amount_cents
          when 'sale_refunded' then p.notify_refunded
          when 'sale_chargeback' then p.notify_chargeback
          when 'alert' then p.notify_alerts
          else false
        end
    and not coalesce(
      case
        when p.quiet_hours_start is null or p.quiet_hours_start = p.quiet_hours_end then false
        when p.quiet_hours_start < p.quiet_hours_end then n.t >= p.quiet_hours_start and n.t < p.quiet_hours_end
        else n.t >= p.quiet_hours_start or n.t < p.quiet_hours_end
      end,
      false
    );
$$;

-- ---------------------------------------------------------------------------
-- Permissões das funções
-- ---------------------------------------------------------------------------

revoke all on function private.alert_rule_matches(uuid, text, text, text, bigint, numeric, bigint, uuid, uuid, timestamptz)
  from public, anon, authenticated;

revoke all on function public.service_evaluate_alert_rules(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.service_evaluate_alert_rules(uuid, timestamptz) to service_role;

revoke all on function public.preview_alert_rule(uuid, text, text, text, bigint, numeric, bigint, uuid, uuid) from public, anon;
grant execute on function public.preview_alert_rule(uuid, text, text, text, bigint, numeric, bigint, uuid, uuid) to authenticated;

revoke all on function public.dismiss_alert(uuid) from public, anon;
grant execute on function public.dismiss_alert(uuid) to authenticated;

revoke all on function public.service_notification_recipients(uuid, text, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.service_notification_recipients(uuid, text, bigint, timestamptz) to service_role;
