-- Nishiads · Testes do Drinfy que chegaram sem UTM (31/10 a 01/11).
--
-- Nesses dias o evento "teste" saía da volta do checkout da Stripe com outro visitante,
-- então chegou sem o UTM guardado e ficou sem anúncio. Desde 02/11 o app manda o mesmo
-- visitante e os testes já chegam ligados ao anúncio.
--
-- A sessão de checkout (dedupe_key do teste) leva ao usuário no banco do Drinfy
-- (webhook_logs.metadata.sessionId → userId), e o usuário é o dedupe_key do cadastro.
-- Aqui o teste herda o UTM do cadastro da mesma pessoa e é reatribuído.

with link (session_id, user_id) as (
  values
    ('cs_live_b1OmciXwvQCe3LypgLyGwMMO6UZ9DDob3zFH1YrHWgY63b5Dvzth1Mmksu', '7379965f-1da8-4bf9-801d-b733a44955d8'),
    ('cs_live_b1ghgD0n0NBpjQNQe3d4Yo0FczhS3L7rYdUl3xy6Mzhf8af8rNv4i2QpvK', 'fbd18ba0-798a-4dd1-885b-139149c915fc'),
    ('cs_live_b14iTM8pm7bfPQM8pPyk9Dd8L8ENFih4eSwdWywMhFhFaC7Ci38WsqInKO', '27ec5104-de1d-4218-bcd7-c08bfd467abb'),
    ('cs_live_b1kkyfRLSCbEhzscKcZXugRqFTbh0IR7usZYHwBGbopxffDqoivnvStLvs', '9ff793a3-2ac0-4ec2-8c51-6a996a6f0e09')
)
update public.tracking_events t
set utm_source = c.utm_source,
    utm_medium = c.utm_medium,
    utm_campaign = c.utm_campaign,
    utm_content = c.utm_content,
    utm_term = c.utm_term,
    touched_at = c.touched_at
from link l
join public.tracking_events c on c.event = 'cadastro' and c.dedupe_key = l.user_id
where t.event = 'teste'
  and t.dedupe_key = l.session_id
  and t.source_id = c.source_id
  and t.attribution_status = 'unattributed'
  and coalesce(t.utm_campaign, t.utm_medium, t.utm_content) is null
  and coalesce(c.utm_campaign, c.utm_medium, c.utm_content) is not null;

select private.attribute_tracking_event(t.id)
from public.tracking_events t
where t.event = 'teste'
  and t.dedupe_key in (
    'cs_live_b1OmciXwvQCe3LypgLyGwMMO6UZ9DDob3zFH1YrHWgY63b5Dvzth1Mmksu',
    'cs_live_b1ghgD0n0NBpjQNQe3d4Yo0FczhS3L7rYdUl3xy6Mzhf8af8rNv4i2QpvK',
    'cs_live_b14iTM8pm7bfPQM8pPyk9Dd8L8ENFih4eSwdWywMhFhFaC7Ci38WsqInKO',
    'cs_live_b1kkyfRLSCbEhzscKcZXugRqFTbh0IR7usZYHwBGbopxffDqoivnvStLvs'
  );
