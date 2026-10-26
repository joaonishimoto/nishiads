import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/app/copy-field";
import { PageHeader, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { ATTRIBUTION_META } from "@/features/sales/meta";
import { META_URL_PARAMETERS } from "@/lib/utm";

const CAPTURE_SNIPPET = `<script>
  // Nishiads: guarda as UTMs do anúncio por 30 dias.
  (function () {
    var keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
    var params = new URLSearchParams(location.search);
    if (!keys.some(function (k) { return params.get(k); })) return;
    var utms = {};
    keys.forEach(function (k) {
      var v = params.get(k);
      if (v) utms[k] = v.slice(0, 500);
    });
    try {
      localStorage.setItem("nishiads_utms", JSON.stringify({ utms: utms, savedAt: Date.now() }));
    } catch (e) {}
  })();
</script>`;

const READ_SNIPPET = `// No front, ao pedir para o seu servidor criar o checkout:
function getSavedUtms() {
  try {
    var saved = JSON.parse(localStorage.getItem("nishiads_utms") || "null");
    var maxAge = 30 * 24 * 60 * 60 * 1000;
    if (!saved || Date.now() - saved.savedAt > maxAge) return {};
    return saved.utms;
  } catch (e) {
    return {};
  }
}

await fetch("/api/checkout", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ priceId, utms: getSavedUtms() }),
});`;

const SERVER_SNIPPET = `// No servidor (Node, Deno ou Edge Function), onde a Checkout Session é criada:
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

function pickUtms(input) {
  const utms = {};
  for (const key of UTM_KEYS) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) utms[key] = value.trim().slice(0, 500);
  }
  return utms;
}

const utms = pickUtms(body.utms);

const session = await stripe.checkout.sessions.create({
  mode: "subscription", // ou "payment" para venda avulsa
  line_items: [{ price: priceId, quantity: 1 }],
  // Lido pelo Nishiads em checkout.session.completed (venda avulsa)
  // e quando a assinatura nasce desta sessão.
  metadata: { ...utms, product_name: "Nome do produto" },
  // Só no modo assinatura: as renovações (invoice.paid) herdam a origem.
  subscription_data: { metadata: utms },
  success_url: "https://seusite.com/obrigado",
  cancel_url: "https://seusite.com/planos",
});`;

const KIWIFY_LINK_SNIPPET = `<script>
  // Nishiads: repassa as UTMs da página para os links de checkout da Kiwify.
  document.addEventListener("DOMContentLoaded", function () {
    var params = new URLSearchParams(location.search);
    document.querySelectorAll('a[href*="kiwify.com.br"]').forEach(function (a) {
      var url = new URL(a.href);
      params.forEach(function (value, key) {
        if (key.indexOf("utm_") === 0) url.searchParams.set(key, value);
      });
      a.href = url.toString();
    });
  });
</script>`;

const SECTIONS = [
  { id: "como-funciona", title: "Como o Nishiads atribui uma venda" },
  { id: "meta", title: "1. Parâmetros de URL nos anúncios" },
  { id: "kiwify", title: "2a. Checkout Kiwify" },
  { id: "stripe", title: "2b. Checkout Stripe" },
  { id: "stripe-utms", title: "3. UTMs num checkout próprio (Stripe)" },
  { id: "status", title: "Status de atribuição" },
  { id: "eventos", title: "Reembolsos, chargebacks e renovações" },
  { id: "testar", title: "Como testar" },
  { id: "problemas", title: "Problemas comuns" },
  { id: "checklist", title: "Checklist por conta de checkout" },
];

function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success("Copiado.");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  }

  return (
    <div className="relative min-w-0">
      <pre
        aria-label={label}
        className="max-h-[28rem] overflow-auto rounded-md border border-border bg-surface-muted p-3 pr-12 font-mono text-xs leading-5 text-foreground"
      >
        <code>{code}</code>
      </pre>
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={copy}
        aria-label={`Copiar ${label}`}
        className="absolute right-2 top-2"
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
      <Panel title={title}>
        <div className="space-y-3 p-4 text-sm leading-6 text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
          {children}
        </div>
      </Panel>
    </section>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="list-decimal space-y-1.5 pl-5">{children}</ol>;
}

function Bullets({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5">{children}</ul>;
}

function C({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-muted px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>;
}

export function HelpPage() {
  const { workspace } = useWorkspace();
  const base = `/w/${workspace.id}`;
  const link = (to: string, text: string) => (
    <Link to={`${base}${to}`} className="font-medium text-primary underline-offset-2 hover:underline">
      {text}
    </Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documentação"
        subtitle="Tudo o que é preciso para cada venda chegar com a campanha, o conjunto e o criativo de origem."
      />

      <nav aria-label="Nesta página" className="rounded-md border border-border bg-surface p-4">
        <p className="mb-2 text-sm font-medium text-foreground">Nesta página</p>
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="text-primary underline-offset-2 hover:underline">
                {s.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="como-funciona" title="Como o Nishiads atribui uma venda">
        <p>A atribuição depende de uma corrente de 4 elos. Se um elo faltar, a venda entra mesmo assim, mas sem origem.</p>
        <Steps>
          <li>
            <strong>Anúncio:</strong> a Meta adiciona ao link as UTMs com o nome e o id da campanha, do conjunto e do
            anúncio.
          </li>
          <li>
            <strong>Página:</strong> a pessoa chega ao seu site ou app com essas UTMs na URL.
          </li>
          <li>
            <strong>Checkout:</strong> as UTMs precisam chegar ao checkout (Kiwify pela URL, Stripe pelo metadata).
          </li>
          <li>
            <strong>Webhook:</strong> o checkout avisa o Nishiads da venda, já com as UTMs, e o Nishiads liga a venda
            ao anúncio.
          </li>
        </Steps>
        <p>
          As UTMs usam o formato <C>nome|id</C>. O Nishiads usa o <strong>id</strong> que vem depois do <C>|</C>,
          então a atribuição continua funcionando se você renomear campanhas ou anúncios. Sem id, ele tenta pelo nome,
          desde que o nome seja único.
        </p>
        <Bullets>
          <li>
            <C>utm_campaign</C> → campanha · <C>utm_medium</C> → conjunto · <C>utm_content</C> → anúncio ·{" "}
            <C>utm_term</C> → posicionamento
          </li>
        </Bullets>
      </Section>

      <Section id="meta" title="1. Parâmetros de URL nos anúncios">
        <p>Em todos os anúncios, no Gerenciador de Anúncios da Meta:</p>
        <Steps>
          <li>Abra o anúncio e role até Rastreamento › Parâmetros de URL.</li>
          <li>Cole o texto abaixo, exatamente como está.</li>
          <li>Publique. Anúncios duplicados herdam o campo; anúncios novos criados do zero, não.</li>
        </Steps>
        <CopyField value={META_URL_PARAMETERS} label="parâmetros de URL" />
        <p>
          A Meta troca cada <C>{"{{...}}"}</C> pelos valores reais na hora do clique. Não troque os nomes das chaves (
          <C>utm_campaign</C> etc.), porque é por elas que o Nishiads lê a origem.
        </p>
      </Section>

      <Section id="kiwify" title="2a. Checkout Kiwify">
        <p>
          <strong>Conexão:</strong> em {link("/integracoes", "Integrações")}, clique em Conectar checkout › Kiwify e
          siga o passo a passo do card (webhook, eventos e token).
        </p>
        <p>
          <strong>UTMs:</strong> a Kiwify repassa ao webhook as UTMs que estiverem na URL do checkout. Então:
        </p>
        <Bullets>
          <li>
            Se o anúncio leva <strong>direto para o link de checkout</strong> da Kiwify, não precisa fazer mais nada.
          </li>
          <li>
            Se o anúncio leva para uma <strong>página de vendas</strong>, os botões de compra precisam levar as UTMs da
            página para o link da Kiwify. Cole este script na página (antes de <C>{"</body>"}</C>):
          </li>
        </Bullets>
        <CodeBlock code={KIWIFY_LINK_SNIPPET} label="script de repasse de UTMs para a Kiwify" />
      </Section>

      <Section id="stripe" title="2b. Checkout Stripe">
        <p>
          <strong>Conexão:</strong> em {link("/integracoes", "Integrações")}, clique em Conectar checkout › Stripe e
          siga o passo a passo do card. Em resumo:
        </p>
        <Steps>
          <li>
            Na Stripe, crie um destino de webhook (Endpoint de webhook) com a URL do card e os 6 eventos:{" "}
            <C>checkout.session.completed</C>, <C>checkout.session.async_payment_succeeded</C>,{" "}
            <C>checkout.session.async_payment_failed</C>, <C>invoice.paid</C>, <C>charge.refunded</C> e{" "}
            <C>charge.dispute.created</C>.
          </li>
          <li>
            Copie o Segredo de assinatura (<C>whsec_...</C>).
          </li>
          <li>
            Em Chaves de API, use <strong>Criar chave restrita</strong> (não Criar chave secret). Escolha o modelo
            Relatórios, análises e contabilidade, troque <strong>Checkout Sessions</strong> para Leitura e confira
            Leitura em Invoices e Charges and Refunds. A chave começa com <C>rk_live_</C>.
          </li>
          <li>Salve as duas chaves no card da integração.</li>
        </Steps>
        <p>
          <strong>Por que a chave restrita:</strong> nas assinaturas, a Stripe não manda no webhook o pagamento nem as
          UTMs da compra original. O Nishiads usa a chave, só de leitura, para buscar esses dados. Ela não consegue
          cobrar, reembolsar nem alterar nada.
        </p>
        <p>
          <strong>UTMs:</strong> a Stripe não lê UTMs da URL. Quem cria a Checkout Session precisa mandá-las (próxima
          seção). Payment Links da Stripe não aceitam UTMs; para atribuir, use Checkout Session criada pelo seu código.
        </p>
      </Section>

      <Section id="stripe-utms" title="3. UTMs num checkout próprio (Stripe)">
        <p>
          Vale para qualquer app que cria a Checkout Session pelo próprio código (ex.: Drinfy, FreelaPro). São 3
          partes:
        </p>
        <p>
          <strong>a) Guardar as UTMs na chegada.</strong> Cole no <C>{"<head>"}</C> de todas as páginas públicas. Elas
          ficam guardadas por 30 dias, e a pessoa pode se cadastrar e assinar depois.
        </p>
        <CodeBlock code={CAPTURE_SNIPPET} label="script de captura de UTMs" />
        <p>
          <strong>b) Enviar as UTMs ao criar o checkout.</strong> No clique em assinar ou comprar, mande as UTMs
          guardadas junto com o pedido ao seu servidor.
        </p>
        <CodeBlock code={READ_SNIPPET} label="leitura das UTMs no front" />
        <p>
          <strong>c) Colocar as UTMs no metadata da Checkout Session.</strong> Em <C>metadata</C> e, nas assinaturas,
          também em <C>subscription_data.metadata</C>. É isso que o Nishiads lê.
        </p>
        <CodeBlock code={SERVER_SNIPPET} label="criação da Checkout Session com UTMs" />
        <Bullets>
          <li>
            Opcional: <C>product_name</C> e <C>product_id</C> no metadata dão nome ao produto na venda. Sem eles, o
            Nishiads usa o nome do item da Stripe.
          </li>
          <li>A Stripe aceita até 500 caracteres por valor de metadata; os snippets já cortam nesse limite.</li>
          <li>Não coloque e-mail, nome ou outros dados pessoais no metadata.</li>
        </Bullets>
      </Section>

      <Section id="status" title="Status de atribuição">
        <Bullets>
          {(Object.keys(ATTRIBUTION_META) as (keyof typeof ATTRIBUTION_META)[]).map((key) => (
            <li key={key}>
              <strong>{ATTRIBUTION_META[key].label}:</strong> {ATTRIBUTION_META[key].description}
            </li>
          ))}
        </Bullets>
        <p>
          Vendas <strong>Parciais</strong> ficam assim enquanto a conta de anúncios da Meta não estiver conectada e
          sincronizada, ou se o anúncio for de outra conta. Depois de sincronizar, use{" "}
          <strong>Refazer atribuição</strong> em {link("/vendas", "Vendas")} para ligar as vendas antigas.
        </p>
        <p>
          Vendas <strong>Sem origem</strong> não têm como ser corrigidas depois: as UTMs não chegaram ao checkout.
          Confira os passos 1 a 3 para as próximas vendas.
        </p>
      </Section>

      <Section id="eventos" title="Reembolsos, chargebacks e renovações">
        <Bullets>
          <li>
            <strong>Reembolso total:</strong> a venda muda para Reembolsada e sai da receita. Reembolso parcial mantém
            a venda aprovada.
          </li>
          <li>
            <strong>Chargeback:</strong> a venda muda para Chargeback e você recebe um alerta.
          </li>
          <li>
            <strong>Renovação de assinatura (Stripe):</strong> cada cobrança paga entra como uma venda nova, atribuída
            ao anúncio da primeira compra. Faturas de valor zero (período de teste) são ignoradas.
          </li>
          <li>
            <strong>Pix e boleto:</strong> entram como Pendente e viram Aprovada quando o pagamento compensa.
          </li>
          <li>Um mesmo evento recebido duas vezes não duplica a venda nem a notificação.</li>
        </Bullets>
      </Section>

      <Section id="testar" title="Como testar">
        <Steps>
          <li>
            <strong>Webhook:</strong> no checkout, envie um evento de teste (Kiwify: Testar webhook; Stripe: abra um
            evento no destino e clique em Reenviar).
          </li>
          <li>
            Abra {link("/integracoes/logs", "Logs de integração")}. O evento deve aparecer como Processado. Se
            aparecer Recusado, o token ou o segredo está errado.
          </li>
          <li>
            <strong>UTMs:</strong> abra a sua página com UTMs de teste, por exemplo{" "}
            <C>?utm_campaign=Teste|1&amp;utm_content=Criativo|2</C>, e faça uma compra de teste. Em{" "}
            {link("/vendas", "Vendas")}, abra a venda: as UTMs devem aparecer no detalhe.
          </li>
          <li>
            Ative as notificações em {link("/ajustes/notificacoes", "Ajustes › Notificações")} para receber o push
            de cada venda.
          </li>
        </Steps>
      </Section>

      <Section id="problemas" title="Problemas comuns">
        <Bullets>
          <li>
            <strong>Card mostra “Faltam as chaves” ou “Falta o token”:</strong> os webhooks são recusados até você
            salvar o segredo no card.
          </li>
          <li>
            <strong>Nenhum evento nos Logs:</strong> a URL no checkout está errada ou os eventos não foram marcados.
            Confira a URL completa, que termina com um código longo.
          </li>
          <li>
            <strong>Evento “Recusado” (Stripe):</strong> o Segredo de assinatura é de outro destino. Cada destino tem
            o seu <C>whsec_</C>.
          </li>
          <li>
            <strong>Evento “Falhou” com erro da Stripe API:</strong> a chave restrita está sem Leitura em Checkout
            Sessions, Invoices ou Charges, ou foi expirada. Edite a chave na Stripe ou salve uma nova.
          </li>
          <li>
            <strong>Evento “Ignorado”:</strong> é normal. Alguns eventos não mudam vendas, como o fim do checkout de
            uma assinatura na Stripe (a venda entra pelo <C>invoice.paid</C>) ou uma fatura de valor zero. O motivo
            aparece no log.
          </li>
          <li>
            <strong>Vendas Sem origem:</strong> os parâmetros não estão no anúncio, a página não repassou as UTMs ou
            o checkout próprio não enviou o metadata.
          </li>
          <li>
            <strong>Vendas Parciais:</strong> a conta de anúncios ainda não foi sincronizada. Depois, use Refazer
            atribuição.
          </li>
        </Bullets>
      </Section>

      <Section id="checklist" title="Checklist por conta de checkout">
        <p>Cada conta de checkout é uma integração separada, com URL e segredos próprios. Para cada nova conta:</p>
        <Steps>
          <li>Conectar checkout em Integrações, com um nome que identifique a conta.</li>
          <li>Configurar o webhook no checkout com a URL do card e os eventos listados.</li>
          <li>Salvar o token (Kiwify) ou as duas chaves (Stripe) no card.</li>
          <li>Garantir os Parâmetros de URL em todos os anúncios que levam a esse produto.</li>
          <li>Garantir que as UTMs chegam ao checkout (script na página ou metadata na Checkout Session).</li>
          <li>Enviar um evento de teste e conferir nos Logs de integração.</li>
        </Steps>
      </Section>
    </div>
  );
}
