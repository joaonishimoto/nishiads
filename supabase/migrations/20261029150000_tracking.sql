-- Nishiads · Rastreamento próprio (script do Nishistack Ads nos sites e apps).
--
-- Cada site ou app rastreado é uma "fonte" com uma chave pública. O script
-- nishistack-ads.js guarda o UTM e o fbclid de quem chega pelo anúncio e manda os
-- eventos (cadastro, teste, compra...) para a Edge Function `track`, que chama
-- service_track_event(). O evento é ligado ao anúncio pelas UTMs, do mesmo jeito
-- que as vendas (utm_campaign → campanha · utm_medium → conjunto · utm_content → anúncio).

create table public.tracking_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- Vai no código colado no site. Não é segredo: só identifica a fonte.
  public_key text not null unique default private.random_token(),
  active boolean not null default true,
  last_event_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);

create trigger tracking_sources_set_updated_at
before update on public.tracking_sources
for each row execute function private.set_updated_at();

create table public.tracking_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source_id uuid not null,
  -- "cadastro", "teste", "compra" ou outro nome escolhido no app.
  event text not null check (event ~ '^[a-z0-9_]{1,40}$'),
  -- Evita contar duas vezes: o id que o app mandou (ex.: id do usuário) ou o id do envio.
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  visitor_id text check (char_length(visitor_id) <= 100),
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  fbclid text,
  landing_url text,
  -- Quando a pessoa chegou pelo anúncio (o UTM guardado).
  touched_at timestamptz,
  campaign_id uuid,
  adset_id uuid,
  ad_id uuid,
  attribution_status public.attribution_status not null default 'unattributed',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (source_id, event, dedupe_key),
  foreign key (source_id, workspace_id)
    references public.tracking_sources (id, workspace_id) on delete cascade,
  foreign key (campaign_id, workspace_id)
    references public.campaigns (id, workspace_id) on delete set null (campaign_id),
  foreign key (adset_id, workspace_id)
    references public.adsets (id, workspace_id) on delete set null (adset_id),
  foreign key (ad_id, workspace_id)
    references public.ads (id, workspace_id) on delete set null (ad_id)
);

create index tracking_events_workspace_occurred_idx on public.tracking_events (workspace_id, occurred_at desc);
create index tracking_events_unmatched_idx on public.tracking_events (workspace_id)
  where attribution_status <> 'matched';

-- ---------------------------------------------------------------------------
-- Privilégios e RLS (mesmo padrão das integrações de checkout)
-- ---------------------------------------------------------------------------

revoke all on public.tracking_sources, public.tracking_events from anon, authenticated;
grant select on public.tracking_sources, public.tracking_events to authenticated;
grant update (name, active), delete on public.tracking_sources to authenticated;
grant all on public.tracking_sources, public.tracking_events to service_role;

alter table public.tracking_sources enable row level security;
alter table public.tracking_events enable row level security;

create policy "tracking_sources: membros leem"
on public.tracking_sources for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

create policy "tracking_sources: owner e admin editam"
on public.tracking_sources for update to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
with check (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "tracking_sources: owner e admin excluem"
on public.tracking_sources for delete to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "tracking_events: membros leem"
on public.tracking_events for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

-- ---------------------------------------------------------------------------
-- Funções
-- ---------------------------------------------------------------------------

create function public.create_tracking_source(p_workspace_id uuid, p_name text)
returns public.tracking_sources
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.tracking_sources;
begin
  perform private.require_role(p_workspace_id, array['owner', 'admin']::public.workspace_role[]);
  insert into public.tracking_sources (workspace_id, name, created_by)
  values (p_workspace_id, btrim(p_name), (select auth.uid()))
  returning * into v_source;
  return v_source;
end;
$$;

-- Liga um evento ao anúncio pelas UTMs (ids da Meta valem mais que nomes).
create function private.attribute_tracking_event(p_event_id bigint)
returns public.attribution_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.tracking_events;
  v_campaign_ref record;
  v_adset_ref record;
  v_ad_ref record;
  v_campaign_id uuid;
  v_adset_id uuid;
  v_adset_campaign_id uuid;
  v_ad_id uuid;
  v_ad_adset_id uuid;
  v_ad_campaign_id uuid;
  v_status public.attribution_status;
begin
  select * into v_event from public.tracking_events where id = p_event_id;
  if not found then
    return null;
  end if;

  select * into v_campaign_ref from private.split_utm_ref(v_event.utm_campaign);
  select * into v_adset_ref from private.split_utm_ref(v_event.utm_medium);
  select * into v_ad_ref from private.split_utm_ref(v_event.utm_content);

  if v_campaign_ref.ref_id is not null then
    select c.id into v_campaign_id
    from public.campaigns c
    where c.workspace_id = v_event.workspace_id and c.external_id = v_campaign_ref.ref_id
    limit 1;
  end if;
  if v_campaign_id is null and v_campaign_ref.ref_name is not null then
    select (array_agg(c.id))[1] into v_campaign_id
    from public.campaigns c
    where c.workspace_id = v_event.workspace_id and lower(c.name) = lower(v_campaign_ref.ref_name)
    having count(*) = 1;
  end if;

  if v_adset_ref.ref_id is not null then
    select s.id, s.campaign_id into v_adset_id, v_adset_campaign_id
    from public.adsets s
    where s.workspace_id = v_event.workspace_id and s.external_id = v_adset_ref.ref_id
    limit 1;
  end if;
  if v_adset_id is null and v_adset_ref.ref_name is not null then
    select (array_agg(s.id))[1], (array_agg(s.campaign_id))[1] into v_adset_id, v_adset_campaign_id
    from public.adsets s
    where s.workspace_id = v_event.workspace_id
      and lower(s.name) = lower(v_adset_ref.ref_name)
      and (v_campaign_id is null or s.campaign_id = v_campaign_id)
    having count(*) = 1;
  end if;

  if v_ad_ref.ref_id is not null then
    select a.id, a.adset_id, a.campaign_id into v_ad_id, v_ad_adset_id, v_ad_campaign_id
    from public.ads a
    where a.workspace_id = v_event.workspace_id and a.external_id = v_ad_ref.ref_id
    limit 1;
  end if;
  if v_ad_id is null and v_ad_ref.ref_name is not null then
    select (array_agg(a.id))[1], (array_agg(a.adset_id))[1], (array_agg(a.campaign_id))[1]
      into v_ad_id, v_ad_adset_id, v_ad_campaign_id
    from public.ads a
    where a.workspace_id = v_event.workspace_id
      and lower(a.name) = lower(v_ad_ref.ref_name)
      and (v_adset_id is null or a.adset_id = v_adset_id)
      and (v_campaign_id is null or a.campaign_id = v_campaign_id)
    having count(*) = 1;
  end if;

  if v_ad_id is not null then
    v_adset_id := v_ad_adset_id;
    v_campaign_id := v_ad_campaign_id;
  elsif v_adset_id is not null then
    v_campaign_id := v_adset_campaign_id;
  end if;

  v_status := case
    when v_ad_id is not null then 'matched'
    when coalesce(v_event.utm_campaign, v_event.utm_medium, v_event.utm_content) is not null then 'partial'
    else 'unattributed'
  end;

  update public.tracking_events e
  set campaign_id = v_campaign_id,
      adset_id = v_adset_id,
      ad_id = v_ad_id,
      attribution_status = v_status
  where e.id = p_event_id
    and (e.campaign_id, e.adset_id, e.ad_id, e.attribution_status)
        is distinct from (v_campaign_id, v_adset_id, v_ad_id, v_status);

  return v_status;
end;
$$;

-- Edge Function `track` (service_role). Idempotente por (fonte, evento, dedupe_key).
-- p_event: { event, dedupe_key, visitor_id, utm_source, utm_medium, utm_campaign,
--            utm_content, utm_term, fbclid, landing_url, touched_at }
create function public.service_track_event(p_public_key text, p_event jsonb)
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
  return jsonb_build_object('ok', true, 'attribution_status', v_status);
end;
$$;

-- A reatribuição depois de cada sincronização da Meta passa a cobrir também os eventos
-- (um anúncio novo pode ter recebido cadastros antes de aparecer no ADS).
create or replace function private.reattribute_workspace_sales(p_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale_id uuid;
  v_event_id bigint;
  v_matched integer := 0;
begin
  for v_sale_id in
    select s.id from public.sales s
    where s.workspace_id = p_workspace_id and s.attribution_status <> 'matched'
  loop
    if private.attribute_sale(v_sale_id) = 'matched' then
      v_matched := v_matched + 1;
    end if;
  end loop;
  for v_event_id in
    select e.id from public.tracking_events e
    where e.workspace_id = p_workspace_id and e.attribution_status = 'partial'
  loop
    perform private.attribute_tracking_event(v_event_id);
  end loop;
  return v_matched;
end;
$$;

revoke all on function private.attribute_tracking_event(bigint) from public;
revoke all on function public.create_tracking_source(uuid, text) from public, anon;
grant execute on function public.create_tracking_source(uuid, text) to authenticated;
revoke all on function public.service_track_event(text, jsonb) from public, anon, authenticated;
grant execute on function public.service_track_event(text, jsonb) to service_role;
