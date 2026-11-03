-- Nishiads · Eventos da mesma pessoa herdam o anúncio do cadastro.
--
-- O "teste" do Drinfy sai da página de volta do checkout da Stripe. Se o cookie com o UTM
-- não estiver lá (outro navegador, aba anônima, cookie limpo), o evento chega sem origem e
-- fica fora do anúncio, mesmo sendo da mesma pessoa que se cadastrou por ele.
--
-- Agora o app pode dizer quem é a pessoa: nishistack('teste', { id: sessao, user: usuario.id }).
-- Um evento sem UTM herda a origem do evento anterior da mesma pessoa na mesma fonte:
-- primeiro pelo usuário (o cadastro usa o id do usuário como id), depois pelo visitante.

alter table public.tracking_events
  add column person_ref text check (char_length(person_ref) <= 200);

comment on column public.tracking_events.person_ref is
  'Quem fez o evento no app (ex.: id do usuário), para eventos sem UTM herdarem o anúncio do cadastro.';

create index tracking_events_person_idx on public.tracking_events (source_id, person_ref)
  where person_ref is not null;
create index tracking_events_dedupe_idx on public.tracking_events (source_id, dedupe_key);
create index tracking_events_visitor_idx on public.tracking_events (source_id, visitor_id)
  where visitor_id is not null;

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
  v_person text := nullif(left(p_event ->> 'person_ref', 200), '');
  v_visitor text := nullif(left(p_event ->> 'visitor_id', 100), '');
  v_origin public.tracking_events;
begin
  select * into v_source
  from public.tracking_sources s
  where s.public_key = p_public_key and s.active;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown_key');
  end if;

  -- Sem UTM: a origem do último evento da mesma pessoa que veio com UTM.
  if coalesce(
       nullif(p_event ->> 'utm_campaign', ''),
       nullif(p_event ->> 'utm_medium', ''),
       nullif(p_event ->> 'utm_content', '')
     ) is null then
    select e.* into v_origin
    from public.tracking_events e
    where e.source_id = v_source.id
      and coalesce(e.utm_campaign, e.utm_medium, e.utm_content) is not null
      and (
        (v_person is not null and (e.person_ref = v_person or e.dedupe_key = v_person))
        or (v_visitor is not null and e.visitor_id = v_visitor)
      )
    order by (v_person is not null and (e.person_ref = v_person or e.dedupe_key = v_person)) desc,
             e.occurred_at desc
    limit 1;
  end if;

  insert into public.tracking_events (
    workspace_id, source_id, event, dedupe_key, visitor_id, person_ref,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, landing_url, touched_at
  )
  values (
    v_source.workspace_id,
    v_source.id,
    p_event ->> 'event',
    left(p_event ->> 'dedupe_key', 200),
    v_visitor,
    v_person,
    coalesce(nullif(left(p_event ->> 'utm_source', 500), ''), v_origin.utm_source),
    coalesce(nullif(left(p_event ->> 'utm_medium', 500), ''), v_origin.utm_medium),
    coalesce(nullif(left(p_event ->> 'utm_campaign', 500), ''), v_origin.utm_campaign),
    coalesce(nullif(left(p_event ->> 'utm_content', 500), ''), v_origin.utm_content),
    coalesce(nullif(left(p_event ->> 'utm_term', 500), ''), v_origin.utm_term),
    coalesce(nullif(left(p_event ->> 'fbclid', 500), ''), v_origin.fbclid),
    nullif(left(p_event ->> 'landing_url', 1000), ''),
    coalesce((p_event ->> 'touched_at')::timestamptz, v_origin.touched_at)
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

revoke all on function public.service_track_event(text, jsonb) from public, anon, authenticated;
grant execute on function public.service_track_event(text, jsonb) to service_role;

-- Coluna nova "Custo por teste" (cpt): entra nos templates de Campanhas que já mostram Testes,
-- logo depois do custo por cadastro (ou de Testes, sem ele).
update public.view_templates
set items = case
  when 'cpl' = any (items) then
    items[1:array_position(items, 'cpl')] || array['cpt'] || items[array_position(items, 'cpl') + 1:]
  else
    items[1:array_position(items, 'trials')] || array['cpt'] || items[array_position(items, 'trials') + 1:]
end
where page = 'campaigns' and 'trials' = any (items) and not ('cpt' = any (items));
