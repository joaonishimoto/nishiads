-- Nishiads · Etapa 1 · Canais e preferências de notificação (Web Push e Telegram).
--
-- Ambas as tabelas apontam para workspace_members: quem sai do workspace
-- deixa de receber notificações dele automaticamente.

create table public.notification_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id uuid not null,
  channel public.notification_channel not null,
  -- Web Push: URL do push service. Telegram: nulo (o chat_id fica em config).
  endpoint text,
  -- Web Push: { "p256dh": "...", "auth": "..." }. Telegram: { "chat_id": 123 }.
  config jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  user_agent text,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (channel <> 'webpush' or endpoint like 'https://%'),
  unique nulls not distinct (workspace_id, user_id, channel, endpoint),
  foreign key (workspace_id, user_id)
    references public.workspace_members (workspace_id, user_id) on delete cascade
);

create index notification_subscriptions_user_idx on public.notification_subscriptions (user_id);

create trigger notification_subscriptions_set_updated_at
before update on public.notification_subscriptions
for each row execute function private.set_updated_at();

create table public.notification_preferences (
  workspace_id uuid not null,
  user_id uuid not null,
  notify_approved boolean not null default true,
  notify_refunded boolean not null default true,
  notify_chargeback boolean not null default true,
  min_amount_cents bigint not null default 0 check (min_amount_cents >= 0),
  -- Horário de silêncio no fuso do workspace; pode atravessar a meia-noite (22:00–07:00).
  quiet_hours_start time,
  quiet_hours_end time,
  sound_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  check ((quiet_hours_start is null) = (quiet_hours_end is null)),
  foreign key (workspace_id, user_id)
    references public.workspace_members (workspace_id, user_id) on delete cascade
);

create index notification_preferences_user_idx on public.notification_preferences (user_id);

create trigger notification_preferences_set_updated_at
before update on public.notification_preferences
for each row execute function private.set_updated_at();

-- Todo membro novo já nasce com as preferências padrão.
create function private.create_default_notification_preferences()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notification_preferences (workspace_id, user_id)
  values (new.workspace_id, new.user_id)
  on conflict do nothing;
  return new;
end;
$$;

create trigger workspace_members_default_preferences
after insert on public.workspace_members
for each row execute function private.create_default_notification_preferences();

revoke all on function private.create_default_notification_preferences() from public;
