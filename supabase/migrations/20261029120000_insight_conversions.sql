-- Nishiads · Cadastros e testes por anúncio, como a Meta atribui.
--
-- O app manda CompleteRegistration e StartTrial para o pixel (e pela Conversions API). A
-- Meta casa esses eventos com o anúncio mesmo quando a pessoa troca de navegador, então os
-- números vêm do campo actions dos insights, junto com gasto e cliques.

alter table public.ad_insights_daily
  add column registrations bigint not null default 0 check (registrations >= 0),
  add column trials bigint not null default 0 check (trials >= 0);

comment on column public.ad_insights_daily.registrations is 'Cadastros (CompleteRegistration) que a Meta atribuiu ao anúncio no dia.';
comment on column public.ad_insights_daily.trials is 'Testes iniciados (StartTrial) que a Meta atribuiu ao anúncio no dia.';

-- A próxima sincronização refaz os últimos 30 dias, para preencher as colunas novas.
update public.ad_accounts set backfilled_at = null where backfilled_at is not null;
