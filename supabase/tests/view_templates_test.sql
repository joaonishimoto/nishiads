-- Testes dos templates de visualização: cada usuário vê e mexe só nos seus, um padrão
-- por tela e limite por tela.
\set ON_ERROR_STOP 1
\o /dev/null
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000f1', 'tpl-a@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000f2', 'tpl-b@teste.nishiads.dev', now()),
  ('00000000-0000-0000-0000-0000000000f3', 'tpl-intruso@teste.nishiads.dev', now());
insert into public.workspaces (id, name, timezone, currency)
values ('f0000000-0000-0000-0000-000000000001', 'WS templates', 'America/Sao_Paulo', 'BRL');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('f0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f1', 'owner'),
  ('f0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f2', 'viewer');

set local role authenticated;

-- Viewer também cria os próprios templates.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2"}', true);
insert into public.view_templates (workspace_id, page, name, items, is_default)
values ('f0000000-0000-0000-0000-000000000001', 'dashboard', 'Do B', array['revenue'], true);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1"}', true);
insert into public.view_templates (workspace_id, page, name, items, is_default) values
  ('f0000000-0000-0000-0000-000000000001', 'dashboard', 'Tráfego', array['spend', 'roas'], true),
  ('f0000000-0000-0000-0000-000000000001', 'dashboard', 'Lucro', array['profit'], false),
  ('f0000000-0000-0000-0000-000000000001', 'campaigns', 'Enxuto', array['spend', 'roas'], true);

do $$ begin
  -- Só os próprios.
  if (select count(*) from public.view_templates) <> 3 then
    raise exception 'A deveria ver só os 3 templates dele';
  end if;
  -- Marcar outro como padrão desmarca o anterior só na mesma tela.
  update public.view_templates set is_default = true where name = 'Lucro';
  if (select string_agg(name, ',' order by name) from public.view_templates where is_default) <> 'Enxuto,Lucro' then
    raise exception 'Padrão deveria ser um por tela';
  end if;
  -- Não dá para criar em nome de outro usuário.
  begin
    insert into public.view_templates (workspace_id, user_id, page, name, items)
    values ('f0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f2', 'dashboard', 'X', array['a']);
    raise exception 'insert com user_id de outro deveria falhar';
  exception when insufficient_privilege then null;
  end;
  -- Tela inválida e lista vazia são recusadas.
  begin
    insert into public.view_templates (workspace_id, page, name, items)
    values ('f0000000-0000-0000-0000-000000000001', 'vendas', 'X', array['a']);
    raise exception 'tela inválida deveria falhar';
  exception when check_violation then null;
  end;
  begin
    insert into public.view_templates (workspace_id, page, name, items)
    values ('f0000000-0000-0000-0000-000000000001', 'dashboard', 'X', array[]::text[]);
    raise exception 'template vazio deveria falhar';
  exception when check_violation then null;
  end;
end $$;

-- B não vê, não edita e não apaga os de A.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2"}', true);
do $$ begin
  if (select count(*) from public.view_templates) <> 1 then
    raise exception 'B deveria ver só o template dele';
  end if;
  update public.view_templates set name = 'hack' where name = 'Tráfego';
  delete from public.view_templates where name = 'Lucro';
end $$;

-- Quem não é membro não cria no workspace.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f3"}', true);
do $$ begin
  begin
    insert into public.view_templates (workspace_id, page, name, items)
    values ('f0000000-0000-0000-0000-000000000001', 'dashboard', 'X', array['a']);
    raise exception 'não membro deveria falhar';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1"}', true);
do $$ begin
  if exists (select 1 from public.view_templates where name = 'hack')
     or (select count(*) from public.view_templates) <> 3 then
    raise exception 'B não deveria alterar os templates de A';
  end if;
  -- Limite de 20 por tela.
  for i in 1..18 loop
    insert into public.view_templates (workspace_id, page, name, items)
    values ('f0000000-0000-0000-0000-000000000001', 'dashboard', 'T' || i, array['a']);
  end loop;
  begin
    insert into public.view_templates (workspace_id, page, name, items)
    values ('f0000000-0000-0000-0000-000000000001', 'dashboard', 'Demais', array['a']);
    raise exception 'limite deveria barrar o 21º';
  exception when invalid_parameter_value then null;
  end;
end $$;

rollback;
\o
\echo 'view_templates: ok'
