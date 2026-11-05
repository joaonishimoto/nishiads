-- Nishiads · Resumo diário por push.
--
-- Cada membro escolhe, no próprio workspace, se quer receber um resumo do dia, em que
-- horário (no fuso do workspace), de qual dia (hoje, até o horário do envio, ou o dia
-- anterior inteiro) e com que texto. O texto é um modelo com variáveis, como
-- {cadastros}, {testes} e {roas}, trocadas pelos números do dia na hora do envio.
--
-- O pg_cron chama a Edge Function daily-summary a cada 5 minutos. Ela pega os resumos
-- que venceram (service_claim_daily_summaries marca o dia como enviado antes de mandar,
-- então dois disparos ao mesmo tempo não repetem o push), calcula os números do dia
-- (service_daily_summary_numbers) e manda o push para os dispositivos da pessoa. O
-- resumo foi pedido para aquele horário, então ignora o horário de silêncio.
--
-- Os números seguem o Dashboard: vendas aprovadas e gasto na moeda do workspace;
-- cadastros do rastreamento próprio (ou, sem ele, os que a Meta atribuiu); testes
-- iniciados pelo checkout (ou, sem eles, os do rastreamento e depois os da Meta); e os
-- testes em andamento valem o valor por venda do produto em "ROAS com testes".

create table public.daily_summary_settings (
  workspace_id uuid not null,
  user_id uuid not null,
  enabled boolean not null default true,
  -- Horário do envio no fuso do workspace.
  send_time time not null default '21:00',
  -- today: o dia do envio, até a hora do envio · yesterday: o dia anterior inteiro.
  period text not null default 'today' check (period in ('today', 'yesterday')),
  title_template text not null default '📊 Resumo de {dia}'
    check (char_length(btrim(title_template)) between 1 and 120),
  body_template text not null default E'Cadastros: {cadastros}\nTestes: {testes}\nVendas: {vendas} · {faturamento}\nGasto: {gasto} · ROAS {roas}'
    check (char_length(btrim(body_template)) between 1 and 1000),
  -- Dia (no fuso do workspace) do último envio agendado: no máximo um por dia.
  last_sent_on date,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  foreign key (workspace_id, user_id)
    references public.workspace_members (workspace_id, user_id) on delete cascade
);

create index daily_summary_settings_user_idx on public.daily_summary_settings (user_id);
create index daily_summary_settings_enabled_idx on public.daily_summary_settings (send_time) where enabled;

create trigger daily_summary_settings_set_updated_at
before update on public.daily_summary_settings
for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: cada pessoa vê e muda só o próprio resumo.
-- ---------------------------------------------------------------------------

alter table public.daily_summary_settings enable row level security;
revoke all on public.daily_summary_settings from anon, authenticated;
grant select, delete on public.daily_summary_settings to authenticated;
grant insert (workspace_id, user_id, enabled, send_time, period, title_template, body_template)
  on public.daily_summary_settings to authenticated;
grant update (enabled, send_time, period, title_template, body_template)
  on public.daily_summary_settings to authenticated;
grant all on public.daily_summary_settings to service_role;

create policy "daily_summary_settings: a pessoa lê o seu"
on public.daily_summary_settings for select to authenticated
using (user_id = (select auth.uid()));

create policy "daily_summary_settings: membro cria o seu"
on public.daily_summary_settings for insert to authenticated
with check (user_id = (select auth.uid()) and private.is_workspace_member(workspace_id));

create policy "daily_summary_settings: a pessoa edita o seu"
on public.daily_summary_settings for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "daily_summary_settings: a pessoa apaga o seu"
on public.daily_summary_settings for delete to authenticated
using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Números do dia
-- ---------------------------------------------------------------------------

-- Números de um dia do workspace (no fuso dele), de 00:00 até p_until (ou o dia todo).
create function private.daily_summary_numbers(p_workspace_id uuid, p_day date, p_until timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with w as (
    select
      w.name,
      w.currency,
      w.timezone,
      (p_day::timestamp at time zone w.timezone) as starts_at,
      least(((p_day + 1)::timestamp at time zone w.timezone), coalesce(p_until, 'infinity'::timestamptz)) as ends_at
    from public.workspaces w
    where w.id = p_workspace_id
  ),
  insights as (
    select
      coalesce(sum(i.spend_cents), 0)::bigint as spend_cents,
      coalesce(sum(i.link_clicks), 0)::bigint as link_clicks,
      coalesce(sum(i.impressions), 0)::bigint as impressions,
      coalesce(sum(i.registrations), 0)::bigint as meta_registrations,
      coalesce(sum(i.trials), 0)::bigint as meta_trials
    from public.ad_insights_daily i
    cross join w
    where i.workspace_id = p_workspace_id and i.date = p_day and i.currency = w.currency
  ),
  day_sales as (
    select s.*
    from public.sales s
    cross join w
    where s.workspace_id = p_workspace_id
      and coalesce(s.paid_at, s.created_at) >= w.starts_at
      and coalesce(s.paid_at, s.created_at) < w.ends_at
  ),
  approved as (
    select
      count(*)::bigint as sales,
      coalesce(sum(s.gross_amount_cents) filter (where s.currency = w.currency), 0)::bigint as revenue_cents
    from day_sales s
    cross join w
    where s.status = 'approved'
  ),
  -- Preço de referência de cada teste: valor por venda do produto; sem ele, a última
  -- venda aprovada do produto; sem ela, a última da conta (ou o primeiro valor informado).
  latest_by_product as (
    select distinct on (s.product_id) s.product_id, s.gross_amount_cents
    from public.sales s
    cross join w
    where s.workspace_id = p_workspace_id and s.status = 'approved' and s.currency = w.currency
      and s.gross_amount_cents > 0 and s.product_id is not null
    order by s.product_id, s.paid_at desc nulls last, s.created_at desc
  ),
  fallback as (
    select coalesce(
      (select s.gross_amount_cents
       from public.sales s cross join w
       where s.workspace_id = p_workspace_id and s.status = 'approved' and s.currency = w.currency
         and s.gross_amount_cents > 0
       order by s.paid_at desc nulls last, s.created_at desc
       limit 1),
      (select p.sale_value_cents from public.products p
       where p.workspace_id = p_workspace_id and p.sale_value_cents > 0
       order by p.name, p.id limit 1)
    ) as cents
  ),
  trials as (
    select
      count(*)::bigint as started,
      count(*) filter (where s.trial_converted_at is null)::bigint as open,
      coalesce(sum(
        case when s.trial_converted_at is null then
          coalesce(nullif(p.sale_value_cents, 0), lp.gross_amount_cents, f.cents, 0)
        end
      ), 0)::bigint as open_value_cents
    from day_sales s
    left join public.products p on p.id = s.product_id
    left join latest_by_product lp on lp.product_id = s.product_id
    cross join fallback f
    where s.status::text = 'trialing'
  ),
  tracked as (
    select
      count(*) filter (where e.event = 'cadastro')::bigint as registrations,
      count(*) filter (where e.event = 'teste')::bigint as trials
    from public.tracking_events e
    cross join w
    where e.workspace_id = p_workspace_id and e.occurred_at >= w.starts_at and e.occurred_at < w.ends_at
  ),
  n as (
    select
      i.spend_cents,
      i.link_clicks,
      i.impressions,
      case when t.registrations > 0 then t.registrations else i.meta_registrations end as registrations,
      case when tr.started > 0 then tr.started when t.trials > 0 then t.trials else i.meta_trials end as trials,
      tr.open as open_trials,
      tr.open_value_cents,
      a.sales,
      a.revenue_cents
    from insights i, approved a, trials tr, tracked t
  )
  select jsonb_build_object(
    'workspace', w.name,
    'currency', w.currency,
    'timezone', w.timezone,
    'day', p_day,
    'spend_cents', n.spend_cents,
    'link_clicks', n.link_clicks,
    'impressions', n.impressions,
    'registrations', n.registrations,
    'trials', n.trials,
    'open_trials', n.open_trials,
    'trial_value_cents', n.open_value_cents,
    'sales', n.sales,
    'revenue_cents', n.revenue_cents,
    'earnings_cents', n.revenue_cents + n.open_value_cents,
    'roas', case when n.spend_cents > 0 then round(n.revenue_cents::numeric / n.spend_cents, 4) end,
    'trial_roas', case when n.spend_cents > 0
      then round((n.revenue_cents + n.open_value_cents)::numeric / n.spend_cents, 4) end,
    'cpa_cents', case when n.sales > 0 and n.spend_cents > 0 then round(n.spend_cents::numeric / n.sales) end,
    'cost_per_registration_cents', case when n.registrations > 0 and n.spend_cents > 0
      then round(n.spend_cents::numeric / n.registrations) end,
    'cost_per_trial_cents', case when n.trials > 0 and n.spend_cents > 0
      then round(n.spend_cents::numeric / n.trials) end
  )
  from w, n;
$$;

-- Prévia no app: números de hoje (até agora) ou de ontem, para quem é membro.
create function public.daily_summary_numbers(p_workspace_id uuid, p_period text default 'today')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
begin
  if (select auth.uid()) is null then
    raise exception 'Faça login para continuar.' using errcode = '28000';
  end if;
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Você não tem acesso a este workspace.' using errcode = '42501';
  end if;
  select (now() at time zone w.timezone)::date into v_today from public.workspaces w where w.id = p_workspace_id;
  if p_period = 'yesterday' then
    return private.daily_summary_numbers(p_workspace_id, v_today - 1, null);
  end if;
  return private.daily_summary_numbers(p_workspace_id, v_today, now());
end;
$$;

-- Edge Function: números de um dia, até um instante.
create function public.service_daily_summary_numbers(p_workspace_id uuid, p_day date, p_until timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.daily_summary_numbers(p_workspace_id, p_day, p_until);
$$;

-- ---------------------------------------------------------------------------
-- Agenda
-- ---------------------------------------------------------------------------

-- Resumos que venceram: o horário do envio de hoje (ou de ontem, para um envio às
-- 23:58 que o cron só pega depois da meia-noite) já passou há menos de 2 horas e o dia
-- ainda não foi enviado. Marca o dia como enviado e devolve o que mandar.
create function public.service_claim_daily_summaries(p_now timestamptz default now())
returns table (
  workspace_id uuid,
  user_id uuid,
  period text,
  title_template text,
  body_template text,
  scheduled_on date,
  summary_day date,
  until_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select distinct on (d.workspace_id, d.user_id)
      d.workspace_id,
      d.user_id,
      c.day as scheduled_on,
      ((c.day + d.send_time)::timestamp at time zone w.timezone) as scheduled_at
    from public.daily_summary_settings d
    join public.workspaces w on w.id = d.workspace_id
    cross join lateral (
      values ((p_now at time zone w.timezone)::date), ((p_now at time zone w.timezone)::date - 1)
    ) as c (day)
    where d.enabled
      and p_now >= ((c.day + d.send_time)::timestamp at time zone w.timezone)
      and p_now < ((c.day + d.send_time)::timestamp at time zone w.timezone) + interval '2 hours'
      and (d.last_sent_on is null or d.last_sent_on < c.day)
    order by d.workspace_id, d.user_id, c.day desc
  ),
  claimed as (
    update public.daily_summary_settings d
    set last_sent_on = due.scheduled_on, last_sent_at = p_now
    from due
    where d.workspace_id = due.workspace_id and d.user_id = due.user_id
      and (d.last_sent_on is null or d.last_sent_on < due.scheduled_on)
    returning d.workspace_id, d.user_id, d.period, d.title_template, d.body_template, due.scheduled_on, due.scheduled_at
  )
  select
    c.workspace_id,
    c.user_id,
    c.period,
    c.title_template,
    c.body_template,
    c.scheduled_on,
    case when c.period = 'yesterday' then c.scheduled_on - 1 else c.scheduled_on end as summary_day,
    case when c.period = 'yesterday' then null else c.scheduled_at end as until_at
  from claimed c;
$$;

-- Agenda o envio a cada 5 minutos (usa o mesmo segredo do cron da Meta).
--   select private.schedule_daily_summary('https://<ref>.supabase.co');
create function private.schedule_daily_summary(p_project_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_project_url !~ '^https://[a-z0-9-]+\.supabase\.co$' then
    raise exception 'Informe a URL do projeto, ex.: https://abcd.supabase.co' using errcode = '22023';
  end if;
  if not exists (select 1 from vault.secrets where name = 'nishiads_cron_secret') then
    perform vault.create_secret(private.random_token(), 'nishiads_cron_secret', 'pg_cron → Edge Functions');
  end if;
  perform cron.schedule(
    'nishiads-daily-summary',
    '*/5 * * * *',
    format(
      $cmd$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'nishiads_cron_secret')
        ),
        body := '{"source":"cron"}'::jsonb,
        timeout_milliseconds := 10000
      );
      $cmd$,
      p_project_url || '/functions/v1/daily-summary'
    )
  );
end;
$$;

-- Se a sincronização da Meta já está agendada, agenda o resumo com a mesma URL.
do $$
declare
  v_url text;
begin
  if to_regclass('cron.job') is null then
    return;
  end if;
  execute $q$
    select substring(command from '(https://[a-z0-9-]+\.supabase\.co)/functions/v1/meta-sync')
    from cron.job where jobname = 'nishiads-meta-sync' limit 1
  $q$ into v_url;
  if v_url is not null then
    perform private.schedule_daily_summary(v_url);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Permissões das funções
-- ---------------------------------------------------------------------------

revoke all on function private.daily_summary_numbers(uuid, date, timestamptz) from public, anon, authenticated;
revoke all on function private.schedule_daily_summary(text) from public, anon, authenticated;

revoke all on function public.daily_summary_numbers(uuid, text) from public, anon;
grant execute on function public.daily_summary_numbers(uuid, text) to authenticated;

revoke all on function public.service_daily_summary_numbers(uuid, date, timestamptz) from public, anon, authenticated;
grant execute on function public.service_daily_summary_numbers(uuid, date, timestamptz) to service_role;

revoke all on function public.service_claim_daily_summaries(timestamptz) from public, anon, authenticated;
grant execute on function public.service_claim_daily_summaries(timestamptz) to service_role;
