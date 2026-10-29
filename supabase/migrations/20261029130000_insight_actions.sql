-- Nishiads · Todas as ações da Meta por anúncio e dia.
--
-- O campo actions dos insights (visualizações da página, leads, inícios de checkout,
-- engajamento...) fica guardado inteiro, action_type → quantidade. O app decide o que
-- mostrar, então uma métrica nova não precisa de outra coluna aqui.

alter table public.ad_insights_daily
  add column actions jsonb not null default '{}'::jsonb;

comment on column public.ad_insights_daily.actions is 'Ações que a Meta atribuiu ao anúncio no dia: { action_type: quantidade }.';

-- A próxima sincronização refaz os últimos 30 dias, para preencher a coluna nova.
update public.ad_accounts set backfilled_at = null where backfilled_at is not null;
