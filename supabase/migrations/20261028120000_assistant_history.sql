-- Nishiads · Histórico do Assistente IA.
--
-- As conversas e as respostas passam a ficar no banco: a Edge Function assistant grava a
-- pergunta, cria a resposta e vai salvando o texto enquanto o modelo escreve, em segundo
-- plano. Sair da tela não interrompe a resposta; ao voltar, o app lê o que já foi escrito.
-- Cada pessoa vê só as próprias conversas. Escritas só pela função (service_role), exceto
-- apagar uma conversa, que a própria pessoa pode fazer.

create table public.assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  -- Recorte (período, filtros e métricas) congelado no início da conversa.
  context jsonb not null,
  -- Período e filtros do recorte, para o app avisar quando a tela mudou.
  scope text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index assistant_conversations_user_idx
  on public.assistant_conversations (workspace_id, user_id, updated_at desc);

create table public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.assistant_conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  -- Sugestões de alteração (pausar, ativar, orçamento) para a pessoa confirmar.
  proposals jsonb not null default '[]',
  -- streaming: o modelo ainda está escrevendo; stopped: a pessoa interrompeu.
  status text not null default 'done' check (status in ('streaming', 'done', 'error', 'stopped')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index assistant_messages_conversation_idx
  on public.assistant_messages (conversation_id, created_at);

alter table public.assistant_conversations enable row level security;
alter table public.assistant_messages enable row level security;
revoke all on public.assistant_conversations from anon, authenticated;
revoke all on public.assistant_messages from anon, authenticated;
grant select, delete on public.assistant_conversations to authenticated;
grant select on public.assistant_messages to authenticated;
grant all on public.assistant_conversations to service_role;
grant all on public.assistant_messages to service_role;

create policy "assistant_conversations: dono lê"
on public.assistant_conversations for select to authenticated
using (
  user_id = (select auth.uid())
  and workspace_id in (select private.member_workspace_ids())
);

create policy "assistant_conversations: dono apaga"
on public.assistant_conversations for delete to authenticated
using (user_id = (select auth.uid()));

create policy "assistant_messages: dono lê"
on public.assistant_messages for select to authenticated
using (
  conversation_id in (
    select id from public.assistant_conversations
    where user_id = (select auth.uid())
      and workspace_id in (select private.member_workspace_ids())
  )
);
