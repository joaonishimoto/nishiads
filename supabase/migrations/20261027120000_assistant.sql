-- Nishiads · Assistente de IA das campanhas.
--
-- A Edge Function assistant conversa com o Claude sobre as métricas do recorte que o
-- usuário está vendo. Cada pergunta respondida fica em assistant_usage (tokens e modelo):
-- serve de limite por usuário e para acompanhar o custo. As conversas em si não são
-- guardadas no banco; ficam no navegador de quem perguntou.

create table public.assistant_usage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  -- Sugestões de alteração mostradas (nunca aplicadas automaticamente).
  proposals integer not null default 0,
  ok boolean not null default true,
  error text,
  created_at timestamptz not null default now()
);

create index assistant_usage_user_created_idx on public.assistant_usage (user_id, created_at desc);
create index assistant_usage_workspace_created_idx on public.assistant_usage (workspace_id, created_at desc);

alter table public.assistant_usage enable row level security;
revoke all on public.assistant_usage from anon, authenticated;
grant select on public.assistant_usage to authenticated;
grant all on public.assistant_usage to service_role;

create policy "assistant_usage: membros leem"
on public.assistant_usage for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));
