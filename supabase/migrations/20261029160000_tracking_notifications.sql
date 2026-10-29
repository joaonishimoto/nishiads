-- Nishiads · Push na hora para cada cadastro do rastreamento próprio.
--
-- A função `track` avisa cada cadastro novo (evento "cadastro") com o criativo de
-- origem, usando a mesma preferência "Cadastros". Enquanto o rastreamento próprio
-- estiver recebendo cadastros, o aviso em lote dos cadastros vistos pela Meta (na
-- sincronização) fica desligado para não repetir o mesmo cadastro.

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
          -- Cadastros vistos pela Meta: só quando o workspace não tem o rastreamento próprio
          -- avisando os cadastros (senão o mesmo cadastro chegaria duas vezes, e atrasado).
          when 'registration' then p.notify_registrations and not exists (
            select 1
            from public.tracking_events e
            join public.tracking_sources ts on ts.id = e.source_id
            where e.workspace_id = p_workspace_id
              and e.event = 'cadastro'
              and ts.active
              and e.occurred_at > p_at - interval '7 days'
          )
          -- Cadastro do rastreamento próprio (script no site), na hora.
          when 'tracked_registration' then p.notify_registrations
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

-- service_track_event passa a devolver o id do evento, para a função montar o push.
create or replace function public.service_track_event(p_public_key text, p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.tracking_sources;
  v_event_id bigint;
  v_status public.attribution_status;
begin
  select * into v_source
  from public.tracking_sources s
  where s.public_key = p_public_key and s.active;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown_key');
  end if;

  insert into public.tracking_events (
    workspace_id, source_id, event, dedupe_key, visitor_id,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, landing_url, touched_at
  )
  values (
    v_source.workspace_id,
    v_source.id,
    p_event ->> 'event',
    left(p_event ->> 'dedupe_key', 200),
    nullif(left(p_event ->> 'visitor_id', 100), ''),
    nullif(left(p_event ->> 'utm_source', 500), ''),
    nullif(left(p_event ->> 'utm_medium', 500), ''),
    nullif(left(p_event ->> 'utm_campaign', 500), ''),
    nullif(left(p_event ->> 'utm_content', 500), ''),
    nullif(left(p_event ->> 'utm_term', 500), ''),
    nullif(left(p_event ->> 'fbclid', 500), ''),
    nullif(left(p_event ->> 'landing_url', 1000), ''),
    (p_event ->> 'touched_at')::timestamptz
  )
  on conflict (source_id, event, dedupe_key) do nothing
  returning id into v_event_id;

  update public.tracking_sources set last_event_at = now() where id = v_source.id;

  if v_event_id is null then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  v_status := private.attribute_tracking_event(v_event_id);
  return jsonb_build_object('ok', true, 'event_id', v_event_id, 'attribution_status', v_status);
end;
$$;
