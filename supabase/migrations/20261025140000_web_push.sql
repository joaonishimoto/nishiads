-- Nishiads · Etapa 3 · Web Push.
--
-- O navegador se inscreve por register_push_subscription(); a Edge Function
-- webhooks, ao processar uma venda, registra a notificação em notification_log
-- (uma vez por venda e tipo, mesmo com reenvios do checkout) e envia para quem
-- service_notification_recipients() devolver, respeitando as preferências.

-- FK composta (venda do mesmo workspace) precisa de unique (id, workspace_id) em sales.
alter table public.sales add constraint sales_id_workspace_id_key unique (id, workspace_id);

create table public.notification_log (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  sale_id uuid not null,
  kind text not null check (kind in ('sale_approved', 'sale_refunded', 'sale_chargeback')),
  recipients integer not null default 0,
  delivered integer not null default 0,
  created_at timestamptz not null default now(),
  unique (sale_id, kind),
  foreign key (sale_id, workspace_id) references public.sales (id, workspace_id) on delete cascade
);

create index notification_log_workspace_idx on public.notification_log (workspace_id, created_at desc);

alter table public.notification_log enable row level security;
-- Escrita só pela service_role (Edge Functions); owner e admin podem auditar.
revoke all on public.notification_log from anon, authenticated;
grant select on public.notification_log to authenticated;
grant all on public.notification_log to service_role;

create policy "notification_log: owner e admin leem"
on public.notification_log for select to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- Inscreve (ou reativa) este navegador para receber pushes do workspace.
create function public.register_push_subscription(
  p_workspace_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'Faça login para continuar.' using errcode = '28000';
  end if;
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Você não tem acesso a este workspace.' using errcode = '42501';
  end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 2000 then
    raise exception 'Endereço de push inválido.' using errcode = '22023';
  end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{80,100}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{16,32}$' then
    raise exception 'Chaves de push inválidas.' using errcode = '22023';
  end if;

  insert into public.notification_subscriptions (workspace_id, user_id, channel, endpoint, config, active, user_agent)
  values (
    p_workspace_id, v_user_id, 'webpush', p_endpoint,
    jsonb_build_object('p256dh', p_p256dh, 'auth', p_auth), true, left(p_user_agent, 300)
  )
  on conflict (workspace_id, user_id, channel, endpoint) do update
    set config = excluded.config, active = true, user_agent = excluded.user_agent
  returning id into v_id;

  return v_id;
end;
$$;

-- Quem recebe o push de uma venda: inscrições ativas cujas preferências aceitam
-- o tipo, o valor mínimo (só para aprovadas) e o horário de silêncio (no fuso do workspace).
create function public.service_notification_recipients(
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

revoke all on function public.register_push_subscription(uuid, text, text, text, text) from public, anon;
grant execute on function public.register_push_subscription(uuid, text, text, text, text) to authenticated;
revoke all on function public.service_notification_recipients(uuid, text, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.service_notification_recipients(uuid, text, bigint, timestamptz) to service_role;
