# Nishistack - ADS

Vendas de infoprodutos e e-commerce atribuídas à **campanha, conjunto e criativo** da Meta Ads, com notificação em tempo real e lucro por anúncio. PWA em pt-BR, BRL, fuso America/Sao_Paulo.

**Stack:** React + Vite + TypeScript, Tailwind v4, shadcn/ui (tokens da marca Nishistack), TanStack Query, React Router · Supabase (Postgres, Auth, RLS, Vault, Edge Functions, Realtime, pg_cron) · Vercel.

## Telas

- **Dashboard** (`/w/:id/dashboard`): métricas gerais do período (faturamento, gasto, lucro, ROAS, CPA, ticket, vendas com origem), gráfico gasto × faturamento, ranking de campanhas e criativos, e a lista de vendas com as abas *Sem origem* e *Testes*. O detalhe de uma venda fica em `/dashboard/vendas/:saleId`; os endereços antigos `/vendas` redirecionam para cá.
- **Campanhas** (`/w/:id/campanhas`): só as campanhas, sem KPIs gerais. Tabela Campanha › Conjunto › Anúncio com as métricas de cada linha e os controles de pausar, ativar e mudar orçamento, e a aba *Criativos*.
- **Assistente IA** (`/w/:id/assistente`): chat que lê os números do período e dos filtros (os mesmos de Campanhas), explica o desempenho e sugere pausar, ativar ou mudar orçamento. Cada sugestão vira um botão que abre o mesmo diálogo de confirmação da tabela; nada muda na Meta sozinho.

## Status das etapas

| # | Etapa | Status |
|---|-------|--------|
| 1 | Schema + RLS + auth + workspaces | ✅ |
| 2 | Webhook de venda (1º provedor) + atribuição por UTM + tela de vendas | ✅ |
| 3 | Notificações Web Push | ✅ |
| 4 | Meta OAuth + sincronização de estrutura e insights | ✅ |
| 5 | Dashboard (ROAS, CPA, lucro por campanha/conjunto/criativo) | |
| 6 | Script de rastreamento + onboarding | |
| 7 | Demais checkouts + bot do Telegram | |

## Rodando localmente

```bash
bun install                      # ou npm install
cp .env.example .env.local       # preencha com a URL e a anon key do Supabase
bun run dev                      # http://localhost:5173
```

### Banco

```bash
npx supabase link --project-ref <ref-do-projeto>
npx supabase db push             # aplica supabase/migrations/*
```

No painel do Supabase → **Authentication → URL Configuration**, coloque a URL do app (`https://ads.nishistack.com`) em *Site URL* e `https://ads.nishistack.com/**` em *Redirect URLs*.

## Variáveis de ambiente

| Onde | Variável | Uso |
|------|----------|-----|
| Vercel / `.env.local` | `VITE_SUPABASE_URL` | URL do projeto Supabase |
| Vercel / `.env.local` | `VITE_SUPABASE_ANON_KEY` | chave pública (anon) |

| Supabase › Edge Functions › Secrets | `VAPID_PUBLIC_KEY` | chave pública VAPID (Web Push); o app busca pela função `push` |
| Supabase › Edge Functions › Secrets | `VAPID_PRIVATE_KEY` | chave privada VAPID |
| Supabase › Edge Functions › Secrets | `VAPID_SUBJECT` | contato do remetente (`https://...` ou `mailto:...`) |
| Supabase › Edge Functions › Secrets | `META_APP_ID` | ID do app da Meta |
| Supabase › Edge Functions › Secrets | `META_APP_SECRET` | chave secreta do app (troca do código e `appsecret_proof`) |
| Supabase › Edge Functions › Secrets | `META_LOGIN_CONFIG_ID` | opcional: id da configuração do *Facebook Login para Empresas* (com `ads_read`, `ads_management` e `business_management`); sem ele, usa `scope=ads_read,ads_management,business_management` |
| Supabase › Edge Functions › Secrets | `APP_URL` | opcional: origens aceitas na volta do login, separadas por vírgula (padrão `https://ads.nishistack.com,https://nishiads.areadeteste.com,http://localhost:5173`) |
| Supabase › Edge Functions › Secrets | `ANTHROPIC_API_KEY` | chave da API da Anthropic (console.anthropic.com › API Keys), usada pela função `assistant` |

Segredos (token da Meta, segredos de webhook, chave VAPID privada) **nunca** vão para o frontend: ficam no Supabase Vault e nos secrets das Edge Functions.

Para gerar um par VAPID novo:

```bash
node -e 'const c=require("crypto");const k=c.generateKeyPairSync("ec",{namedCurve:"prime256v1"});console.log("VAPID_PUBLIC_KEY="+k.publicKey.export({format:"der",type:"spki"}).subarray(-65).toString("base64url"));console.log("VAPID_PRIVATE_KEY="+k.privateKey.export({format:"jwk"}).d)'
```

## Stripe

- Na Stripe, crie um destino de webhook com a URL da integração. Os eventos são:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `checkout.session.async_payment_failed`
  - `invoice.paid`
  - `charge.refunded`
  - `charge.dispute.created`
- Salve no Nishistack - ADS o *signing secret* (`whsec_...`) e uma chave restrita (`rk_live_...`) com leitura em Checkout Sessions, Invoices e Charges. As duas ficam juntas no Vault.
- A venda é identificada pelo PaymentIntent, que liga o pagamento ao reembolso e ao chargeback.
- Assinaturas entram por `invoice.paid`, inclusive as renovações. A chave de API resolve fatura → PaymentIntent (Invoice Payments, API basil+) e busca as UTMs da Checkout Session da assinatura.
- **UTMs:** o checkout precisa mandar `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` e `utm_term` em `metadata` ao criar a Checkout Session, e em `subscription_data.metadata` para as renovações.
- Teste: `scripts/send-test-stripe-webhook.sh "<URL>" "whsec_..."`

## Web Push

- `public/sw.js` mostra a notificação e abre a venda ao tocar.
- Ajustes › Notificações ativa o push neste navegador, lista seus dispositivos e define o que notificar: tipos, valor mínimo, horário de silêncio e som.
- A função `webhooks` notifica depois de gravar a venda. `notification_log` garante um push por venda e tipo, mesmo que o checkout reenvie o webhook.
- A criptografia do payload (RFC 8291) e o JWT VAPID são feitos com Web Crypto, sem dependências, e testados com o vetor oficial da RFC.
- No iPhone, o push só funciona com o app instalado na Tela de Início (iOS 16.4+).

## Meta Ads

- **Conectar:** Integrações › Meta Ads › Conectar. A função `meta-oauth` gera um `state` de uso único (15 min), abre o login da Meta e recebe o retorno em `/functions/v1/meta-oauth/callback`. Lá troca o código por token, converte para **longa duração** (~60 dias), guarda no Vault (`meta_connections.token_ref`) e lista as contas de anúncio. O token nunca passa pelo navegador.
- **Escolher contas:** a chave "Acompanhar" liga a conta (`ad_accounts.is_tracked`) e já dispara o backfill de 30 dias.
- **Sincronização** (`meta-sync`): pg_cron a cada 15 min e o botão *Sincronizar agora*. Para cada conta: dados da conta, campanhas, conjuntos, anúncios (thumbnail 320px do criativo, link de prévia) e insights em `level=ad`, `time_increment=1`. Refaz os últimos 3 dias (a Meta ajusta os números) e faz backfill de 30 dias na primeira vez, em janelas de 10 dias. Depois refaz a atribuição das vendas ainda não casadas.
- **Rate limit:** lê `x-business-use-case-usage`, `x-ad-account-usage` e `x-app-usage`; desacelera acima de 75% e pausa a conta acima de 90% ou nos erros 4/17/32/613/80000+, até o tempo que a Meta informa (mínimo 10 min).
- **Erros:** retry com backoff (2s, 4s, 8s) em erro transitório; token expirado/revogado (190, 102, subcodes 458–467) marca a conexão e as contas como *Reconectar* e manda push para owners/admins. O app avisa 7 dias antes do token expirar.
- **Versão da API:** `GRAPH_API_VERSION` em `supabase/functions/_shared/meta/graph.ts`, a única ocorrência.
- **Uma execução por conta:** `service_claim_ad_account_sync` trava a conta; trava com mais de 10 min é retomada.
- **Controle pelo app** (`meta-actions`): owners e admins pausam e ativam campanha, conjunto ou anúncio e mudam o orçamento (diário ou total, o tipo que o objeto já usa) direto na tabela de Campanhas. Precisa da permissão `ads_management` no login da Meta. A função confere o papel, limita 20 ações por minuto por usuário, confere na Meta onde está o orçamento (campanha CBO × conjunto), faz o POST, relê o objeto e os filhos e grava tudo em `meta_action_log` (Histórico na tela). A lógica fica em `_shared/meta/write.ts` (`setMetaObjectStatus`, `setMetaBudget`), reusada pelas regras automáticas.
- **Agendar o cron** (uma vez, no SQL Editor): `select private.schedule_meta_sync('https://<ref>.supabase.co');`. Cria o segredo `nishiads_cron_secret` no Vault, que o job manda no header `x-cron-secret`.

## Alertas e regras automáticas

- **Regras** (Alertas › Regras, owner/admin): *gastou sem vender*, *ROAS abaixo da meta* ou *CPA acima do máximo*, por campanha, conjunto ou anúncio, olhando hoje, os últimos 3 ou 7 dias (fuso do workspace). Escopo opcional por conta e campanha, e um gasto mínimo antes de julgar ROAS e CPA. Os números são os mesmos do dashboard: vendas aprovadas atribuídas ao item e gasto dos insights diários. Só itens **ativos** na Meta entram.
- **Ação:** *só avisar*, *avisar e pedir para pausar* (botão Pausar no push e na tela) ou *pausar sozinho*, com limite de pausas automáticas por regra por dia (padrão 3). Passou do limite, ou a Meta recusou, vira pedido de aprovação com o motivo.
- **Quando roda:** no fim de cada sincronização da Meta (`meta-sync`), para cada workspace que teve conta atualizada, e no botão *Conferir agora* (função `alerts`). `service_evaluate_alert_rules` grava no máximo **um alerta por regra, item e dia** (`alerts`), então o mesmo anúncio não dispara de novo no mesmo dia, nem se alguém reativar. Pedido sem resposta expira em 24 h.
- **Pausar:** usa `setMetaObjectStatus` de `_shared/meta/write.ts` (o mesmo dos botões de Campanhas), com `source = "rule"`; cada tentativa fica em `meta_action_log`. Precisa da permissão `ads_management` na conexão com a Meta.
- **Push:** um por alerta, ou um resumo quando chegam mais de 3 de uma vez. Respeita a nova preferência *Alertas das regras* e o horário de silêncio de cada membro (a pausa automática acontece mesmo no silêncio). No Chrome/Android o push tem o botão **Pausar**, que abre o alerta com a confirmação.
- **Limites:** 30 regras por workspace; a prévia do formulário mostra até 50 itens.

## Assistente IA

- **Como funciona:** a tela monta o recorte atual (período, filtros, totais e período anterior, série diária, meta de ROAS, custos dos produtos e a árvore Campanha › Conjunto › Anúncio, até 40 campanhas e 25 conjuntos/anúncios por nível, pelos maiores gastos) e manda para a função `assistant`, que conversa com o Claude (`claude-opus-5-5`) e grava a resposta no banco enquanto ela é escrita.
- **Sugestões:** o modelo só sugere pela ferramenta `sugerir_alteracao`; a função confere se o id existe no recorte e se a ação faz sentido (ex.: não pausa o que já está pausado, orçamento só onde há orçamento próprio). No app, o botão abre o diálogo de confirmação de Campanhas, que aplica pela `meta-actions` (owner/admin, com histórico em `meta_action_log`).
- **Conversa e histórico:** ficam no banco (`assistant_conversations` e `assistant_messages`), cada pessoa vê só as suas, com a lista de conversas na lateral (no celular, botão *Histórico*). Cada conversa fica presa ao recorte em que começou; mudou o período ou os filtros, a tela avisa e oferece uma conversa nova.
- **Segundo plano:** a função grava a pergunta, cria a resposta com status `streaming` e devolve na hora; o texto vai sendo salvo enquanto o modelo escreve (`EdgeRuntime.waitUntil`). Sair da tela não interrompe; ao voltar, o app relê a conversa (a cada segundo enquanto há resposta sendo escrita). *Parar* marca a resposta como `stopped` e a geração para na próxima gravação. Respostas cortadas pelo limite de tempo das Edge Functions ficam como erro.
- **Limites e custo:** qualquer membro pode perguntar; 20 perguntas a cada 10 minutos e 200 por dia por pessoa. Cada resposta grava tokens e modelo em `assistant_usage`.

## Conversions API da Meta

- **Configurar:** Integrações › Conversions API › Configurar. ID do pixel (conjunto de dados), token gerado no Gerenciador de Eventos (Configurações › API de Conversões › Gerar token de acesso) e a URL do site. O token vai direto para o Vault (`meta_capi_configs.token_ref`); o app só vê `has_token`.
- **Fila:** o trigger `sales_meta_capi` põe em `meta_capi_events` um evento por venda: aprovada → `Purchase`, teste iniciado → `StartTrial` (opcional), reembolso/chargeback → cancela o `Purchase` ainda não enviado ou, se já foi, manda o evento personalizado `Refund` (opcional, desligado por padrão).
- **Envio** (`meta-capi` e `webhooks`): logo depois do webhook e, para retentativas, pelo pg_cron a cada 5 min (`private.schedule_meta_capi`, agendado sozinho pela migration se a sincronização da Meta já estiver agendada). Um evento por requisição, `POST /{pixel}/events` na `GRAPH_API_VERSION`.
- **Dedup:** `event_id` = id do pedido no checkout (`pi_...` na Stripe, número do pedido na Kiwify). Reenvios e o mesmo evento vindo do pixel do site (com esse `eventID`) contam uma vez.
- **Dados:** `em` (o hash SHA-256 que já guardamos), `external_id` (hash do `cus_...` da Stripe ou o hash do e-mail), `fbc`, `fbp` e `client_user_agent` quando o checkout repassa no metadata (`fbc`, `fbp`, `fbclid`, `client_user_agent`). Renovações (`billing_reason = subscription_cycle`) vão com `action_source = system_generated`; o resto, `website` com `event_source_url`. Se a Meta recusar um evento de site por falta de user agent, ele é reenviado como `other`.
- **Erros:** rede, 5xx e limite → retentativa em 1 min, 5 min, 30 min, 2 h, 6 h e 12 h; token/permissão/pixel errado → avisa no card e tenta de hora em hora (salvar o token novo reenvia na hora); parâmetro inválido → falha. Eventos com mais de 7 dias (limite da Meta) não são enviados. Tudo aparece em Logs de integração › Conversions API.
- **Teste:** com um código de teste salvo, os eventos vão para Gerenciador de Eventos › Testar eventos, e o botão *Enviar evento de teste* manda uma compra fictícia de R$ 1. Apague o código depois de conferir.

## Testes

```bash
bun run test        # unitários (Vitest): validações, papéis, formatação, erros
bun run typecheck
bun run test:db     # RLS/RPCs/Vault num Postgres temporário (precisa dos binários do Postgres 15+)
```

`supabase/tests/rls_test.sql` também roda contra um banco Supabase real (tudo dentro de uma transação desfeita no fim):

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql
```

## Modelo de dados

Todo dado pertence a um `workspace`; o usuário pode estar em vários, com papel `owner`, `admin` ou `viewer`.

- **Tenancy:** `profiles`, `workspaces`, `workspace_members`, `workspace_invitations`
- **Anúncios:** `meta_connections` (token no Vault), `ad_accounts`, `campaigns`, `adsets`, `ads`, `ad_insights_daily` (PK `(ad_id, date)` para upsert), `meta_action_log` (alterações feitas pelo app na Meta)
- **Vendas:** `checkout_integrations`, `products`, `sales` (único em `(workspace_id, provider, external_order_id)`), `webhook_events`
- **Notificações:** `notification_subscriptions`, `notification_preferences`
- **Alertas:** `alert_rules`, `alerts`
- **Conversions API:** `meta_capi_configs` (token no Vault), `meta_capi_events` (fila e log)

Regras que valem para todas as etapas:

- Dinheiro em **centavos** (`bigint`, sufixo `_cents`); datas em `timestamptz` (UTC), exibidas no fuso do workspace.
- **RLS ligado em todas as tabelas**, com policy. O teste `rls_test.sql` falha se alguma tabela de `public` ficar sem RLS ou sem policy.
- Tabelas filhas repetem `workspace_id` e referenciam o pai por FK composta `(id, workspace_id)`: um registro nunca aponta para outro tenant.
- `authenticated` só escreve colunas liberadas por `GRANT` (ex.: `ad_accounts.token_ref` é intocável pelo app). Escritas sensíveis passam por RPCs `security definer` que conferem o papel.
- Tokens e segredos ficam no **Vault**; as tabelas guardam só o id (`token_ref`, `webhook_secret_ref`). Ao apagar a conta/integração, o segredo é apagado junto. Leitura só pela `service_role` (`service_read_secret`).
- E-mail do comprador só como hash SHA-256 (`customer_email_hash`).

Ao criar uma tabela nova: `enable row level security`, policies, `grant` explícito e rode `bun run test:db`.
