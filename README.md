# Nishiads

Vendas de infoprodutos e e-commerce atribuídas à **campanha, conjunto e criativo** da Meta Ads, com notificação em tempo real e lucro por anúncio. PWA em pt-BR, BRL, fuso America/Sao_Paulo.

**Stack:** React + Vite + TypeScript, Tailwind v4, shadcn/ui (tokens da marca Nishistack), TanStack Query, React Router · Supabase (Postgres, Auth, RLS, Vault, Edge Functions, Realtime, pg_cron) · Vercel.

## Status das etapas

| # | Etapa | Status |
|---|-------|--------|
| 1 | Schema + RLS + auth + workspaces | ✅ |
| 2 | Webhook de venda (1º provedor) + atribuição por UTM + tela de vendas | ⏳ |
| 3 | Notificações Web Push | |
| 4 | Meta OAuth + sincronização de estrutura e insights | |
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

No painel do Supabase → **Authentication → URL Configuration**, adicione a URL do app (ex.: `https://nishiads.vercel.app`) em *Site URL* e `https://nishiads.vercel.app/redefinir-senha` em *Redirect URLs*.

## Variáveis de ambiente

| Onde | Variável | Uso |
|------|----------|-----|
| Vercel / `.env.local` | `VITE_SUPABASE_URL` | URL do projeto Supabase |
| Vercel / `.env.local` | `VITE_SUPABASE_ANON_KEY` | chave pública (anon) |

| Supabase › Edge Functions › Secrets | `VAPID_PUBLIC_KEY` | chave pública VAPID (Web Push); o app busca pela função `push` |
| Supabase › Edge Functions › Secrets | `VAPID_PRIVATE_KEY` | chave privada VAPID |
| Supabase › Edge Functions › Secrets | `VAPID_SUBJECT` | contato do remetente (`https://...` ou `mailto:...`) |

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
- Salve no Nishiads o *signing secret* (`whsec_...`) e uma chave restrita (`rk_live_...`) com leitura em Checkout Sessions, Invoices e Charges. As duas ficam juntas no Vault.
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
- **Anúncios:** `ad_accounts`, `campaigns`, `adsets`, `ads`, `ad_insights_daily` (PK `(ad_id, date)` para upsert)
- **Vendas:** `checkout_integrations`, `products`, `sales` (único em `(workspace_id, provider, external_order_id)`), `webhook_events`
- **Notificações:** `notification_subscriptions`, `notification_preferences`

Regras que valem para todas as etapas:

- Dinheiro em **centavos** (`bigint`, sufixo `_cents`); datas em `timestamptz` (UTC), exibidas no fuso do workspace.
- **RLS ligado em todas as tabelas**, com policy. O teste `rls_test.sql` falha se alguma tabela de `public` ficar sem RLS ou sem policy.
- Tabelas filhas repetem `workspace_id` e referenciam o pai por FK composta `(id, workspace_id)`: um registro nunca aponta para outro tenant.
- `authenticated` só escreve colunas liberadas por `GRANT` (ex.: `ad_accounts.token_ref` é intocável pelo app). Escritas sensíveis passam por RPCs `security definer` que conferem o papel.
- Tokens e segredos ficam no **Vault**; as tabelas guardam só o id (`token_ref`, `webhook_secret_ref`). Ao apagar a conta/integração, o segredo é apagado junto. Leitura só pela `service_role` (`service_read_secret`).
- E-mail do comprador só como hash SHA-256 (`customer_email_hash`).

Ao criar uma tabela nova: `enable row level security`, policies, `grant` explícito e rode `bun run test:db`.
