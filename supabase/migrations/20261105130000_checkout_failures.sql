-- Nishiads · Aviso quando alguém tenta o checkout e não consegue.
--
-- O webhook do checkout grava cada tentativa que falhou em checkout_failures:
--   declined        → cartão recusado no checkout (Stripe: setup_intent.setup_failed ou
--                     payment_intent.payment_failed fora de fatura)
--   expired         → checkout aberto e não concluído (Stripe: checkout.session.expired,
--                     24 h depois de abrir)
--   renewal_failed  → cobrança recusada no fim do teste ou na renovação
--                     (Stripe: invoice.payment_failed)
--
-- O push não sai na hora para o cartão recusado: muita gente erra o cartão e acerta logo
-- em seguida. A falha espera 20 minutos (notify_after) e só avisa se a pessoa não
-- concluiu nesse meio-tempo. A mesma pessoa (person_ref ou e-mail) recebe no máximo um
-- aviso de checkout a cada 36 h, para cinco checkouts abandonados não virarem cinco pushes.
--
-- A Edge Function `webhooks` (rota _process, chamada pelo pg_cron a cada 5 minutos)
-- envia os avisos vencidos. Preferência: notification_preferences.notify_checkout_failures.

create table public.checkout_failures (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  checkout_integration_id uuid,
  provider public.checkout_provider not null,
  kind text not null check (kind in ('declined', 'expired', 'renewal_failed')),
  -- Id da tentativa no provedor (seti_/pi_/cs_/in_...): um registro por tentativa.
  external_ref text not null check (char_length(external_ref) <= 200),
  -- Checkout Session ligada à tentativa, para conferir depois se ela foi concluída.
  session_ref text check (char_length(session_ref) <= 200),
  subscription_ref text check (char_length(subscription_ref) <= 200),
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  currency char(3) not null default 'BRL',
  external_product_id text check (char_length(external_product_id) <= 200),
  product_name text check (char_length(product_name) <= 200),
  customer_email_hash text check (customer_email_hash is null or customer_email_hash ~ '^[0-9a-f]{64}$'),
  person_ref text check (char_length(person_ref) <= 200),
  reason_code text check (char_length(reason_code) <= 100),
  reason_message text check (char_length(reason_message) <= 500),
  utm_source text check (char_length(utm_source) <= 500),
  utm_medium text check (char_length(utm_medium) <= 500),
  utm_campaign text check (char_length(utm_campaign) <= 500),
  utm_content text check (char_length(utm_content) <= 500),
  utm_term text check (char_length(utm_term) <= 500),
  campaign_id uuid references public.campaigns (id) on delete set null,
  ad_id uuid references public.ads (id) on delete set null,
  -- Quando a pessoa começou a tentar (abertura do checkout ou a recusa).
  started_at timestamptz not null default now(),
  occurred_at timestamptz not null default now(),
  notify_after timestamptz not null default now(),
  -- null = aguardando; notified = push enviado; recovered = a pessoa concluiu depois;
  -- duplicate = a mesma pessoa já foi avisada há pouco.
  resolution text check (resolution in ('notified', 'recovered', 'duplicate')),
  resolved_at timestamptz,
  recipients integer not null default 0,
  delivered integer not null default 0,
  created_at timestamptz not null default now(),
  unique (workspace_id, provider, kind, external_ref),
  foreign key (checkout_integration_id, workspace_id)
    references public.checkout_integrations (id, workspace_id) on delete set null (checkout_integration_id)
);

create index checkout_failures_due_idx on public.checkout_failures (notify_after) where resolution is null;
create index checkout_failures_workspace_idx on public.checkout_failures (workspace_id, occurred_at desc);
create index checkout_failures_person_idx on public.checkout_failures (workspace_id, person_ref) where person_ref is not null;
create index checkout_failures_email_idx on public.checkout_failures (workspace_id, customer_email_hash)
  where customer_email_hash is not null;
create index if not exists sales_email_hash_idx on public.sales (workspace_id, customer_email_hash)
  where customer_email_hash is not null;

alter table public.checkout_failures enable row level security;
revoke all on public.checkout_failures from anon, authenticated;
grant select on public.checkout_failures to authenticated;
grant all on public.checkout_failures to service_role;

create policy "checkout_failures: membros leem"
on public.checkout_failures for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

alter table public.notification_preferences
  add column notify_checkout_failures boolean not null default true;
grant update (notify_checkout_failures) on public.notification_preferences to authenticated;

-- Grava (ou ignora, se repetida) uma tentativa de checkout que falhou.
-- p_failure: { kind, external_ref, session_ref, subscription_ref, amount_cents, currency,
--   external_product_id, product_name, customer_email_hash, person_ref, reason_code,
--   reason_message, utm_*, started_at, occurred_at, delay_minutes }
create function public.service_record_checkout_failure(
  p_workspace_id uuid,
  p_checkout_integration_id uuid,
  p_provider public.checkout_provider,
  p_failure jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_person text := nullif(left(p_failure ->> 'person_ref', 200), '');
  v_utm_source text := nullif(left(p_failure ->> 'utm_source', 500), '');
  v_utm_medium text := nullif(left(p_failure ->> 'utm_medium', 500), '');
  v_utm_campaign text := nullif(left(p_failure ->> 'utm_campaign', 500), '');
  v_utm_content text := nullif(left(p_failure ->> 'utm_content', 500), '');
  v_utm_term text := nullif(left(p_failure ->> 'utm_term', 500), '');
  v_origin public.tracking_events;
  v_campaign_ref record;
  v_ad_ref record;
  v_campaign_id uuid;
  v_ad_id uuid;
  v_occurred timestamptz := coalesce((p_failure ->> 'occurred_at')::timestamptz, now());
  v_delay integer := least(greatest(coalesce((p_failure ->> 'delay_minutes')::integer, 0), 0), 24 * 60);
begin
  -- Sem UTM: herda a origem do cadastro da mesma pessoa no rastreamento (como as vendas).
  if v_person is not null and coalesce(v_utm_campaign, v_utm_medium, v_utm_content) is null then
    select e.* into v_origin
    from public.tracking_events e
    where e.workspace_id = p_workspace_id
      and coalesce(e.utm_campaign, e.utm_medium, e.utm_content) is not null
      and (e.person_ref = v_person or e.dedupe_key = v_person)
    order by e.occurred_at desc
    limit 1;
    if found then
      v_utm_source := v_origin.utm_source;
      v_utm_medium := v_origin.utm_medium;
      v_utm_campaign := v_origin.utm_campaign;
      v_utm_content := v_origin.utm_content;
      v_utm_term := v_origin.utm_term;
    end if;
  end if;

  -- Anúncio pelo id do utm_content (ou nome único); a campanha vem do anúncio.
  select * into v_ad_ref from private.split_utm_ref(v_utm_content);
  if v_ad_ref.ref_id is not null then
    select a.id, a.campaign_id into v_ad_id, v_campaign_id
    from public.ads a
    where a.workspace_id = p_workspace_id and a.external_id = v_ad_ref.ref_id
    limit 1;
  end if;
  if v_ad_id is null and v_ad_ref.ref_name is not null then
    select (array_agg(a.id))[1], (array_agg(a.campaign_id))[1] into v_ad_id, v_campaign_id
    from public.ads a
    where a.workspace_id = p_workspace_id and lower(a.name) = lower(v_ad_ref.ref_name)
    having count(*) = 1;
  end if;
  if v_campaign_id is null then
    select * into v_campaign_ref from private.split_utm_ref(v_utm_campaign);
    if v_campaign_ref.ref_id is not null then
      select c.id into v_campaign_id
      from public.campaigns c
      where c.workspace_id = p_workspace_id and c.external_id = v_campaign_ref.ref_id
      limit 1;
    end if;
    if v_campaign_id is null and v_campaign_ref.ref_name is not null then
      select (array_agg(c.id))[1] into v_campaign_id
      from public.campaigns c
      where c.workspace_id = p_workspace_id and lower(c.name) = lower(v_campaign_ref.ref_name)
      having count(*) = 1;
    end if;
  end if;

  insert into public.checkout_failures (
    workspace_id, checkout_integration_id, provider, kind, external_ref, session_ref, subscription_ref,
    amount_cents, currency, external_product_id, product_name, customer_email_hash, person_ref,
    reason_code, reason_message, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    campaign_id, ad_id, started_at, occurred_at, notify_after
  )
  values (
    p_workspace_id,
    p_checkout_integration_id,
    p_provider,
    p_failure ->> 'kind',
    left(p_failure ->> 'external_ref', 200),
    nullif(left(p_failure ->> 'session_ref', 200), ''),
    nullif(left(p_failure ->> 'subscription_ref', 200), ''),
    greatest(coalesce((p_failure ->> 'amount_cents')::bigint, 0), 0),
    upper(coalesce(nullif(left(p_failure ->> 'currency', 3), ''), 'BRL')),
    nullif(left(p_failure ->> 'external_product_id', 200), ''),
    nullif(left(p_failure ->> 'product_name', 200), ''),
    nullif(p_failure ->> 'customer_email_hash', ''),
    v_person,
    nullif(left(p_failure ->> 'reason_code', 100), ''),
    nullif(left(p_failure ->> 'reason_message', 500), ''),
    v_utm_source, v_utm_medium, v_utm_campaign, v_utm_content, v_utm_term,
    v_campaign_id,
    v_ad_id,
    coalesce((p_failure ->> 'started_at')::timestamptz, v_occurred),
    v_occurred,
    now() + make_interval(mins => v_delay)
  )
  on conflict (workspace_id, provider, kind, external_ref) do nothing
  returning id into v_id;

  if v_id is null then
    select f.id into v_id
    from public.checkout_failures f
    where f.workspace_id = p_workspace_id and f.provider = p_provider
      and f.kind = p_failure ->> 'kind' and f.external_ref = left(p_failure ->> 'external_ref', 200);
    return jsonb_build_object('failure_id', v_id, 'inserted', false);
  end if;
  return jsonb_build_object('failure_id', v_id, 'inserted', true);
end;
$$;

-- Marca como recuperada uma falha cuja pessoa concluiu depois (conferido na Stripe).
create function public.service_resolve_checkout_failure(p_failure_id uuid, p_resolution text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.checkout_failures
  set resolution = p_resolution, resolved_at = now()
  where id = p_failure_id and resolution is null and p_resolution in ('recovered', 'duplicate');
$$;

-- Fecha as falhas vencidas: recuperadas (a pessoa concluiu depois), repetidas (a mesma
-- pessoa já foi avisada há menos de 36 h) ou a avisar. Devolve só as que devem virar push,
-- já marcadas como notified (cada falha sai uma vez, mesmo com duas chamadas ao mesmo tempo).
create function public.service_claim_checkout_failures(p_limit integer default 50)
returns table (
  id uuid,
  workspace_id uuid,
  kind text,
  amount_cents bigint,
  currency text,
  product_name text,
  reason_code text,
  reason_message text,
  campaign_name text,
  ad_name text,
  utm_content text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.checkout_failures;
  v_resolution text;
begin
  for f in
    select *
    from public.checkout_failures c
    where c.resolution is null and c.notify_after <= now()
    order by c.occurred_at
    limit least(greatest(p_limit, 1), 200)
    for update skip locked
  loop
    v_resolution := 'notified';

    -- Concluiu depois: teste ou venda da mesma pessoa a partir do início da tentativa.
    if f.kind = 'renewal_failed' then
      -- O teste da assinatura converteu, ou chegou outra cobrança paga da mesma pessoa.
      if exists (
        select 1 from public.sales s
        where s.workspace_id = f.workspace_id
          and s.provider = f.provider
          and (
            (f.subscription_ref is not null and s.external_order_id = f.subscription_ref
              and s.trial_converted_at >= f.started_at)
            or (s.status = 'approved' and s.created_at >= f.started_at
              and (s.person_ref = f.person_ref or s.customer_email_hash = f.customer_email_hash))
          )
      ) then
        v_resolution := 'recovered';
      end if;
    elsif (f.person_ref is not null or f.customer_email_hash is not null) and exists (
      select 1 from public.sales s
      where s.workspace_id = f.workspace_id
        and s.status in ('approved', 'trialing', 'pending')
        and s.created_at >= f.started_at - interval '2 minutes'
        and (s.person_ref = f.person_ref or s.customer_email_hash = f.customer_email_hash)
    ) then
      v_resolution := 'recovered';
    end if;

    -- A mesma pessoa já recebeu aviso de checkout há pouco.
    if v_resolution = 'notified' and f.kind <> 'renewal_failed'
       and (f.person_ref is not null or f.customer_email_hash is not null) and exists (
      select 1 from public.checkout_failures o
      where o.workspace_id = f.workspace_id
        and o.id <> f.id
        and o.kind <> 'renewal_failed'
        and o.resolution = 'notified'
        and o.resolved_at > now() - interval '36 hours'
        and (o.person_ref = f.person_ref or o.customer_email_hash = f.customer_email_hash)
    ) then
      v_resolution := 'duplicate';
    end if;

    update public.checkout_failures c
    set resolution = v_resolution, resolved_at = now()
    where c.id = f.id;

    if v_resolution = 'notified' then
      return query
      select f.id, f.workspace_id, f.kind, f.amount_cents, f.currency::text, f.product_name,
             f.reason_code, f.reason_message,
             (select cp.name from public.campaigns cp where cp.id = f.campaign_id),
             (select a.name from public.ads a where a.id = f.ad_id),
             f.utm_content;
    end if;
  end loop;
end;
$$;

revoke all on function public.service_record_checkout_failure(uuid, uuid, public.checkout_provider, jsonb) from public, anon, authenticated;
revoke all on function public.service_resolve_checkout_failure(uuid, text) from public, anon, authenticated;
revoke all on function public.service_claim_checkout_failures(integer) from public, anon, authenticated;
grant execute on function public.service_record_checkout_failure(uuid, uuid, public.checkout_provider, jsonb) to service_role;
grant execute on function public.service_resolve_checkout_failure(uuid, text) to service_role;
grant execute on function public.service_claim_checkout_failures(integer) to service_role;

-- Quem recebe: inclui o tipo 'checkout_failure' (preferência "Checkout com falha").
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
          when 'checkout_failure' then p.notify_checkout_failures
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

-- Agenda a rota _process do webhook a cada 5 minutos: avisa as falhas de checkout vencidas
-- e reprocessa eventos que falharam. Usa o mesmo segredo do cron da Meta.
--   select private.schedule_checkout_failures('https://<ref>.supabase.co');
create function private.schedule_checkout_failures(p_project_url text)
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
    'nishiads-checkout-failures',
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
      p_project_url || '/functions/v1/webhooks/_process'
    )
  );
end;
$$;

-- Se a sincronização da Meta já está agendada, agenda com a mesma URL.
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
    perform private.schedule_checkout_failures(v_url);
  end if;
end
$$;
