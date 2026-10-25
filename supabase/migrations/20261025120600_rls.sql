-- Nishiads · Etapa 1 · Row Level Security e privilégios.
--
-- Regra geral: `authenticated` lê o que pertence aos seus workspaces e escreve
-- apenas as colunas liberadas abaixo. Sincronização da Meta e webhooks escrevem
-- com a service_role nas Edge Functions. `anon` não acessa nenhuma tabela.

-- ---------------------------------------------------------------------------
-- Privilégios de tabela (antes do RLS, que filtra as linhas)
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

grant update (full_name) on public.profiles to authenticated;
grant update (name, timezone, currency), delete on public.workspaces to authenticated;
grant delete on public.workspace_invitations to authenticated;
-- token_ref, status e afins só mudam pelas Edge Functions.
grant update (name, is_tracked), delete on public.ad_accounts to authenticated;
-- O segredo só muda por set_checkout_integration_secret().
grant update (name, active), delete on public.checkout_integrations to authenticated;
grant insert (workspace_id, provider, external_product_id, name, cost_cents, fee_percent_bps, fee_fixed_cents),
  update (provider, external_product_id, name, cost_cents, fee_percent_bps, fee_fixed_cents),
  delete on public.products to authenticated;
grant insert (workspace_id, user_id, channel, endpoint, config, active, user_agent),
  update (config, active, user_agent),
  delete on public.notification_subscriptions to authenticated;
grant update (notify_approved, notify_refunded, notify_chargeback, min_amount_cents,
  quiet_hours_start, quiet_hours_end, sound_enabled) on public.notification_preferences to authenticated;

-- ---------------------------------------------------------------------------
-- RLS em todas as tabelas
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.ad_accounts enable row level security;
alter table public.campaigns enable row level security;
alter table public.adsets enable row level security;
alter table public.ads enable row level security;
alter table public.ad_insights_daily enable row level security;
alter table public.checkout_integrations enable row level security;
alter table public.products enable row level security;
alter table public.sales enable row level security;
alter table public.webhook_events enable row level security;
alter table public.notification_subscriptions enable row level security;
alter table public.notification_preferences enable row level security;

-- profiles: você e quem divide workspace com você.
create policy "profiles: ler o próprio e de colegas"
on public.profiles for select to authenticated
using (id = (select auth.uid()) or private.shares_workspace_with(id));

create policy "profiles: editar o próprio"
on public.profiles for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

-- workspaces
create policy "workspaces: membros leem"
on public.workspaces for select to authenticated
using (id in (select private.member_workspace_ids()));

create policy "workspaces: owner e admin editam"
on public.workspaces for update to authenticated
using (private.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]))
with check (private.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]));

create policy "workspaces: owner exclui"
on public.workspaces for delete to authenticated
using (private.has_workspace_role(id, array['owner']::public.workspace_role[]));

-- workspace_members: leitura pelos membros; escrita só via RPC.
create policy "workspace_members: membros leem"
on public.workspace_members for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

-- workspace_invitations: owner e admin leem e revogam; criação via RPC.
create policy "workspace_invitations: owner e admin leem"
on public.workspace_invitations for select to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "workspace_invitations: owner e admin revogam"
on public.workspace_invitations for delete to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- ad_accounts
create policy "ad_accounts: membros leem"
on public.ad_accounts for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

create policy "ad_accounts: owner e admin editam"
on public.ad_accounts for update to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
with check (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "ad_accounts: owner e admin desconectam"
on public.ad_accounts for delete to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- Estrutura e insights: somente leitura para membros.
create policy "campaigns: membros leem"
on public.campaigns for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

create policy "adsets: membros leem"
on public.adsets for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

create policy "ads: membros leem"
on public.ads for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

create policy "ad_insights_daily: membros leem"
on public.ad_insights_daily for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

-- checkout_integrations
create policy "checkout_integrations: membros leem"
on public.checkout_integrations for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

create policy "checkout_integrations: owner e admin editam"
on public.checkout_integrations for update to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
with check (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "checkout_integrations: owner e admin excluem"
on public.checkout_integrations for delete to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- products
create policy "products: membros leem"
on public.products for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

create policy "products: owner e admin criam"
on public.products for insert to authenticated
with check (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "products: owner e admin editam"
on public.products for update to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
with check (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "products: owner e admin excluem"
on public.products for delete to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- sales: somente leitura (entram pelos webhooks).
create policy "sales: membros leem"
on public.sales for select to authenticated
using (workspace_id in (select private.member_workspace_ids()));

-- webhook_events: o payload bruto fica restrito a owner e admin.
create policy "webhook_events: owner e admin leem"
on public.webhook_events for select to authenticated
using (private.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- notification_subscriptions: cada pessoa gerencia só os próprios dispositivos.
create policy "notification_subscriptions: ler as próprias"
on public.notification_subscriptions for select to authenticated
using (user_id = (select auth.uid()));

create policy "notification_subscriptions: criar as próprias"
on public.notification_subscriptions for insert to authenticated
with check (user_id = (select auth.uid()) and private.is_workspace_member(workspace_id));

create policy "notification_subscriptions: editar as próprias"
on public.notification_subscriptions for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy "notification_subscriptions: excluir as próprias"
on public.notification_subscriptions for delete to authenticated
using (user_id = (select auth.uid()));

-- notification_preferences: criadas pelo trigger; cada pessoa edita as próprias.
create policy "notification_preferences: ler as próprias"
on public.notification_preferences for select to authenticated
using (user_id = (select auth.uid()));

create policy "notification_preferences: editar as próprias"
on public.notification_preferences for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));
