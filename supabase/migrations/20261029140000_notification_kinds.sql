-- Nishiads · Escolher o que notifica: cadastros e testes iniciados.
--
-- Testes chegam pelo webhook do checkout (venda trialing), então usam o mesmo
-- notification_log das vendas (um push por teste). Cadastros vêm da sincronização da
-- Meta (ad_insights_daily.registrations): a Edge Function avisa quando o número sobe.
--
-- Também corrige o interruptor "Alertas das regras", que não salvava: a coluna
-- notify_alerts foi criada sem permissão de update para os usuários.

alter table public.notification_preferences
  add column notify_registrations boolean not null default true,
  add column notify_trials boolean not null default true;

grant update (notify_alerts, notify_registrations, notify_trials) on public.notification_preferences to authenticated;

alter table public.notification_log drop constraint notification_log_kind_check;
alter table public.notification_log
  add constraint notification_log_kind_check
  check (kind in ('sale_approved', 'sale_refunded', 'sale_chargeback', 'trial_started'));

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
          when 'trial_started' then p.notify_trials
          when 'registration' then p.notify_registrations
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

revoke all on function public.service_notification_recipients(uuid, text, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.service_notification_recipients(uuid, text, bigint, timestamptz) to service_role;
