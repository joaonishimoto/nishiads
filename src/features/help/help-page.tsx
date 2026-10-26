import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  CreditCard,
  Globe,
  Lightbulb,
  Megaphone,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { CopyField } from "@/components/app/copy-field";
import { PageHeader, Status } from "@/components/app/ui";
import { useWorkspace } from "@/features/workspaces/workspace-context";
import { ProviderMark, type ProviderMarkKey } from "@/features/integrations/provider-mark";
import { ATTRIBUTION_META } from "@/features/sales/meta";
import { CAPI_GUIDE_STEPS } from "@/features/meta/capi-panel";
import { META_URL_PARAMETERS } from "@/lib/utm";
import { cn } from "@/lib/utils";

const CAPTURE_SNIPPET = `<script>
  // nishiADS: guarda as UTMs do anúncio por 30 dias.
  (function () {
    var keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
    var params = new URLSearchParams(location.search);
    // Clique do anúncio da Meta, para a Conversions API (fbc = fb.1.<ms>.<fbclid>).
    var fbclid = params.get("fbclid");
    if (fbclid) {
      try {
        localStorage.setItem("nishiads_fbc", "fb.1." + Date.now() + "." + fbclid);
      } catch (e) {}
    }
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

const CLICK_SNIPPET = `// No front, junto com as UTMs: dados do clique para a Conversions API.
function getMetaClick() {
  function cookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : undefined;
  }
  var saved;
  try {
    saved = localStorage.getItem("nishiads_fbc") || undefined;
  } catch (e) {}
  return {
    fbc: cookie("_fbc") || saved, // _fbc e _fbp são criados pelo pixel da Meta
    fbp: cookie("_fbp"),
    client_user_agent: navigator.userAgent.slice(0, 500),
  };
}

// No servidor, ao criar a Checkout Session, some ao metadata das UTMs:
const meta = body.meta || {};
const click = {};
for (const key of ["fbc", "fbp", "client_user_agent"]) {
  if (typeof meta[key] === "string" && meta[key]) click[key] = meta[key].slice(0, 500);
}
// metadata: { ...utms, ...click, product_name: "..." }
// subscription_data: { metadata: { ...utms, ...click } }`;

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
  // Lido pelo nishiADS em checkout.session.completed (venda avulsa)
  // e quando a assinatura nasce desta sessão.
  metadata: { ...utms, product_name: "Nome do produto" },
  // Só no modo assinatura: as renovações (invoice.paid) herdam a origem.
  subscription_data: { metadata: utms },
  success_url: "https://seusite.com/obrigado",
  cancel_url: "https://seusite.com/planos",
});`;

const KIWIFY_LINK_SNIPPET = `<script>
  // nishiADS: repassa as UTMs da página para os links de checkout da Kiwify.
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

const GROUPS: { title: string; sections: { id: string; title: string }[] }[] = [
  {
    title: "Começar",
    sections: [
      { id: "como-funciona", title: "Como a atribuição funciona" },
      { id: "checklist", title: "Checklist de configuração" },
    ],
  },
  {
    title: "Configurar",
    sections: [
      { id: "meta-ads", title: "Conectar a Meta Ads" },
      { id: "meta", title: "Parâmetros de URL" },
      { id: "kiwify", title: "Kiwify" },
      { id: "stripe", title: "Stripe" },
      { id: "stripe-utms", title: "UTMs num checkout próprio" },
      { id: "conversions-api", title: "Conversions API da Meta" },
    ],
  },
  {
    title: "Referência",
    sections: [
      { id: "status", title: "Status de atribuição" },
      { id: "eventos", title: "Reembolsos, renovações e testes" },
      { id: "testar", title: "Como testar" },
      { id: "problemas", title: "Problemas comuns" },
    ],
  },
];

const ALL_SECTIONS = GROUPS.flatMap((g) => g.sections);

/** Seção visível agora, para destacar no índice. */
function useActiveSection(): string {
  const [active, setActive] = useState(ALL_SECTIONS[0]!.id);
  useEffect(() => {
    const elements = ALL_SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (e): e is HTMLElement => !!e,
    );
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -65% 0px" },
    );
    elements.forEach((e) => observer.observe(e));
    return () => observer.disconnect();
  }, []);
  return active;
}

function useCopy(value: string) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Copiado.");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  }
  return { copied, copy };
}

function CodeBlock({ code, label }: { code: string; label: string }) {
  const { copied, copy } = useCopy(code);
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface-muted">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface px-3 py-1.5">
        <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copiar ${label}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" aria-hidden />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden />
          )}
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      <pre className="max-h-[28rem] overflow-auto p-3 font-mono text-xs leading-5 text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Callout({
  tone = "tip",
  title,
  children,
}: {
  tone?: "tip" | "warning";
  title?: string;
  children: ReactNode;
}) {
  const Icon = tone === "tip" ? Lightbulb : AlertTriangle;
  return (
    <div
      className={cn(
        "flex gap-3 rounded-lg border p-3 text-sm",
        tone === "tip" ? "border-info/30 bg-info/8" : "border-warning/35 bg-warning/10",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          tone === "tip" ? "text-info-strong" : "text-warning-strong",
        )}
        aria-hidden
      />
      <div className="min-w-0 text-foreground/90">
        {title && <p className="font-medium text-foreground">{title}</p>}
        <div className={cn(title && "mt-0.5")}>{children}</div>
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  provider,
  lead,
  children,
}: {
  id: string;
  title: string;
  provider?: ProviderMarkKey;
  lead?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-24 border-t border-border pt-8 first:border-t-0 first:pt-0"
    >
      <div className="flex items-center gap-3">
        {provider && <ProviderMark provider={provider} size="sm" />}
        <h2 id={`${id}-title`} className="text-lg font-semibold tracking-[-0.01em] text-foreground">
          <a href={`#${id}`} className="hover:underline hover:underline-offset-4">
            {title}
          </a>
        </h2>
      </div>
      {lead && <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{lead}</p>}
      <div className="mt-4 space-y-4 text-sm leading-6 text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
        {children}
      </div>
    </section>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="space-y-2.5 [counter-reset:step] [&>li]:relative [&>li]:pl-9 [&>li]:[counter-increment:step] [&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:top-0.5 [&>li]:before:flex [&>li]:before:h-6 [&>li]:before:w-6 [&>li]:before:items-center [&>li]:before:justify-center [&>li]:before:rounded-full [&>li]:before:bg-accent [&>li]:before:text-xs [&>li]:before:font-semibold [&>li]:before:text-accent-foreground [&>li]:before:content-[counter(step)]">
      {children}
    </ol>
  );
}

function Bullets({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5 marker:text-border-strong">{children}</ul>;
}

function C({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-surface-muted px-1 py-0.5 font-mono text-xs text-foreground ring-1 ring-border">
      {children}
    </code>
  );
}

const FLOW: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Megaphone,
    title: "Anúncio",
    text: "A Meta põe no link as UTMs com nome e id da campanha, conjunto e anúncio.",
  },
  {
    icon: Globe,
    title: "Página",
    text: "A pessoa chega ao seu site com as UTMs na URL, e elas ficam guardadas.",
  },
  {
    icon: CreditCard,
    title: "Checkout",
    text: "As UTMs vão junto para o checkout (Kiwify pela URL, Stripe pelo metadata).",
  },
  {
    icon: Webhook,
    title: "Webhook",
    text: "O checkout avisa a venda com as UTMs e o nishiADS liga ao anúncio.",
  },
];

function AttributionFlow() {
  return (
    <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {FLOW.map((step, index) => (
        <li
          key={step.title}
          className="relative flex gap-3 rounded-lg border border-border bg-surface p-3 xl:flex-col xl:gap-2"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
            <step.icon className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">
              {index + 1}. {step.title}
            </p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{step.text}</p>
          </div>
          {index < FLOW.length - 1 && (
            <ArrowRight
              className="absolute -right-2.5 top-1/2 z-10 hidden h-4 w-4 -translate-y-1/2 rounded-full bg-background text-muted-foreground xl:block"
              aria-hidden
            />
          )}
        </li>
      ))}
    </ol>
  );
}

function Toc({ active }: { active: string }) {
  return (
    <nav
      aria-label="Nesta página"
      className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] overflow-y-auto pr-2 lg:block"
    >
      {GROUPS.map((group) => (
        <div key={group.title} className="mb-5">
          <p className="mb-1.5 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {group.title}
          </p>
          <ul className="space-y-0.5">
            {group.sections.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  aria-current={active === s.id ? "location" : undefined}
                  className={cn(
                    "block rounded-md border-l-2 px-2 py-1 text-sm transition-colors",
                    active === s.id
                      ? "border-primary bg-accent/60 font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                  )}
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function MobileToc() {
  return (
    <nav aria-label="Nesta página" className="-mx-4 overflow-x-auto px-4 scrollbar-none lg:hidden">
      <ul className="flex gap-2">
        {ALL_SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className="block whitespace-nowrap rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground"
            >
              {s.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const PROBLEMS: [string, ReactNode][] = [
  [
    "Card mostra “Faltam as chaves” ou “Falta o token”",
    "Os webhooks são recusados até você salvar o segredo no card da integração.",
  ],
  [
    "Nenhum evento nos Logs",
    "A URL no checkout está errada ou os eventos não foram marcados. Confira a URL completa, que termina com um código longo.",
  ],
  [
    "Evento “Recusado” (Stripe)",
    <>
      O Segredo de assinatura é de outro destino. Cada destino tem o seu <C>whsec_</C>.
    </>,
  ],
  [
    "Evento “Falhou” com erro da Stripe API",
    "A chave restrita está sem Leitura em Checkout Sessions, Invoices ou Charges, ou expirou. Edite a chave na Stripe ou salve uma nova.",
  ],
  [
    "Evento “Ignorado”",
    <>
      É normal. Alguns eventos não mudam vendas, como o fim do checkout de uma assinatura paga (a
      venda entra pelo <C>invoice.paid</C>) ou uma fatura de valor zero. O motivo aparece no log.
      Início de teste grátis vira Teste iniciado.
    </>,
  ],
  [
    "Vendas Sem origem",
    "Os parâmetros não estão no anúncio, a página não repassou as UTMs ou o checkout próprio não enviou o metadata.",
  ],
  [
    "Vendas Parciais",
    "A conta de anúncios ainda não foi sincronizada. Depois de sincronizar, use Refazer atribuição em Vendas.",
  ],
  [
    "Meta: “URL bloqueada” ao conectar",
    "A URI de redirecionamento no app da Meta não está exatamente igual à do guia. Cole de novo e salve.",
  ],
  [
    "Meta: conta com “Reconectar”",
    "O acesso expirou (dura cerca de 60 dias) ou a senha do Facebook mudou. Clique em Reconectar em Integrações.",
  ],
];

export function HelpPage() {
  const { workspace } = useWorkspace();
  const active = useActiveSection();
  const base = `/w/${workspace.id}`;
  const link = (to: string, text: string) => (
    <Link
      to={`${base}${to}`}
      className="font-medium text-primary underline-offset-2 hover:underline"
    >
      {text}
    </Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documentação"
        subtitle="Tudo o que é preciso para cada venda chegar com a campanha, o conjunto e o criativo de origem."
      />
      <MobileToc />

      <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
        <Toc active={active} />

        <div className="min-w-0 max-w-3xl space-y-10">
          <Section
            id="como-funciona"
            title="Como a atribuição funciona"
            lead="A venda é ligada ao anúncio por uma corrente de 4 elos. Se um faltar, a venda entra mesmo assim, mas sem origem."
          >
            <AttributionFlow />
            <p>
              As UTMs usam o formato <C>nome|id</C>. O nishiADS usa o <strong>id</strong> depois do{" "}
              <C>|</C>, então a atribuição continua funcionando se você renomear campanhas ou
              anúncios. Sem id, ele tenta pelo nome, desde que seja único.
            </p>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface-muted text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Parâmetro</th>
                    <th className="px-3 py-2 font-medium">Identifica</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border bg-surface">
                  {[
                    ["utm_campaign", "Campanha"],
                    ["utm_medium", "Conjunto de anúncios"],
                    ["utm_content", "Anúncio (criativo)"],
                    ["utm_term", "Posicionamento (Feed, Stories, Reels…)"],
                  ].map(([k, v]) => (
                    <tr key={k}>
                      <td className="px-3 py-2">
                        <C>{k}</C>
                      </td>
                      <td className="px-3 py-2 text-foreground">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            id="checklist"
            title="Checklist de configuração"
            lead="Para cada conta de checkout nova. Cada conta é uma integração separada, com URL e segredos próprios."
          >
            <ul className="grid gap-2">
              {[
                <>
                  Conectar a Meta Ads e ligar as contas de anúncio em{" "}
                  {link("/integracoes", "Integrações")}.
                </>,
                "Colar os Parâmetros de URL em todos os anúncios que levam ao produto.",
                "Conectar o checkout em Integrações, com um nome que identifique a conta.",
                "Configurar o webhook no checkout com a URL do card e os eventos listados.",
                "Salvar o token (Kiwify) ou as duas chaves (Stripe) no card.",
                "Garantir que as UTMs chegam ao checkout (script na página ou metadata na Checkout Session).",
                <>
                  Enviar um evento de teste e conferir em{" "}
                  {link("/integracoes/logs", "Logs de integração")}.
                </>,
              ].map((item, index) => (
                <li
                  key={index}
                  className="flex items-start gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-foreground"
                >
                  <span
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border border-border-strong"
                    aria-hidden
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section
            id="meta-ads"
            title="Conectar a Meta Ads"
            provider="meta"
            lead="Traz gasto, impressões, cliques e criativos de cada anúncio. Só leitura: o nishiADS não altera nada nas suas campanhas."
          >
            <Steps>
              <li>
                Em {link("/integracoes", "Integrações")}, clique em{" "}
                <strong>Conectar Meta Ads</strong> e entre com o Facebook que administra as contas
                de anúncio.
              </li>
              <li>Na tela da Meta, escolha os negócios e as contas e aceite as permissões.</li>
              <li>
                De volta ao nishiADS, ligue a chave <strong>Acompanhar</strong> nas contas que
                importam. Cada conta ligada importa os últimos 30 dias na hora.
              </li>
            </Steps>
            <Bullets>
              <li>A sincronização roda a cada 15 minutos. Use Sincronizar agora para forçar.</li>
              <li>
                Os últimos 3 dias são sempre refeitos, porque a Meta ajusta os números depois.
              </li>
              <li>
                Depois de cada sincronização, as vendas Parciais são reatribuídas automaticamente.
              </li>
            </Bullets>
            <Callout tone="warning" title="O acesso dura cerca de 60 dias">
              O app avisa 7 dias antes e manda push quando expira. É só clicar em Reconectar.
            </Callout>
          </Section>

          <Section
            id="meta"
            title="Parâmetros de URL"
            provider="meta"
            lead="Vão em todos os anúncios. É o que faz a venda saber de qual campanha, conjunto e criativo veio."
          >
            <Steps>
              <li>
                No Gerenciador de Anúncios, abra o anúncio e role até Rastreamento › Parâmetros de
                URL.
              </li>
              <li>Cole o texto abaixo, exatamente como está.</li>
              <li>Publique.</li>
            </Steps>
            <CopyField value={META_URL_PARAMETERS} label="parâmetros de URL" />
            <Callout title="Dica">
              Anúncios duplicados herdam o campo; anúncios criados do zero, não. A Meta troca cada{" "}
              <C>{"{{...}}"}</C> pelos valores reais na hora do clique. Não mude os nomes das
              chaves.
            </Callout>
          </Section>

          <Section
            id="kiwify"
            title="Kiwify"
            provider="kiwify"
            lead="A Kiwify repassa ao webhook as UTMs que estiverem na URL do checkout."
          >
            <p>
              <strong>Conexão:</strong> em {link("/integracoes", "Integrações")}, escolha Kiwify e
              siga o passo a passo do card (webhook, eventos e token).
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-surface p-3">
                <p className="font-medium text-foreground">Anúncio → checkout</p>
                <p className="mt-1">
                  Se o anúncio leva direto ao link de checkout, não precisa fazer mais nada.
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface p-3">
                <p className="font-medium text-foreground">Anúncio → página de vendas</p>
                <p className="mt-1">
                  Os botões precisam levar as UTMs para a Kiwify. Cole o script abaixo antes de{" "}
                  <C>{"</body>"}</C>.
                </p>
              </div>
            </div>
            <CodeBlock code={KIWIFY_LINK_SNIPPET} label="Repasse de UTMs para a Kiwify (HTML)" />
          </Section>

          <Section
            id="stripe"
            title="Stripe"
            provider="stripe"
            lead="Webhook assinado mais uma chave restrita só de leitura."
          >
            <Steps>
              <li>
                Na Stripe, crie um destino de webhook (Endpoint de webhook) com a URL do card e os 6
                eventos: <C>checkout.session.completed</C>,{" "}
                <C>checkout.session.async_payment_succeeded</C>,{" "}
                <C>checkout.session.async_payment_failed</C>, <C>invoice.paid</C>,{" "}
                <C>charge.refunded</C> e <C>charge.dispute.created</C>.
              </li>
              <li>
                Copie o Segredo de assinatura (<C>whsec_...</C>).
              </li>
              <li>
                Em Chaves de API, use <strong>Criar chave restrita</strong> (não Criar chave
                secret). Escolha o modelo Relatórios, análises e contabilidade, troque{" "}
                <strong>Checkout Sessions</strong> para Leitura e confira Leitura em Invoices e
                Charges and Refunds. A chave começa com <C>rk_live_</C>.
              </li>
              <li>Salve as duas chaves no card da integração.</li>
            </Steps>
            <Callout title="Por que a chave restrita">
              Nas assinaturas, a Stripe não manda no webhook o pagamento nem as UTMs da compra
              original. O nishiADS usa a chave, só de leitura, para buscar esses dados. Ela não
              consegue cobrar, reembolsar nem alterar nada.
            </Callout>
            <Callout tone="warning" title="A Stripe não lê UTMs da URL">
              Quem cria a Checkout Session precisa mandá-las (próxima seção). Payment Links não
              aceitam UTMs; para atribuir, use uma Checkout Session criada pelo seu código.
            </Callout>
          </Section>

          <Section
            id="stripe-utms"
            title="UTMs num checkout próprio"
            provider="stripe"
            lead="Para apps que criam a Checkout Session pelo próprio código (ex.: Drinfy, FreelaPro). São 3 partes."
          >
            <p>
              <strong>1. Guardar as UTMs na chegada.</strong> Cole no <C>{"<head>"}</C> de todas as
              páginas públicas. Elas ficam guardadas por 30 dias, e a pessoa pode se cadastrar e
              assinar depois.
            </p>
            <CodeBlock code={CAPTURE_SNIPPET} label="Captura de UTMs (HTML)" />
            <p>
              <strong>2. Enviar as UTMs ao criar o checkout.</strong> No clique em assinar ou
              comprar, mande as UTMs guardadas junto com o pedido ao seu servidor.
            </p>
            <CodeBlock code={READ_SNIPPET} label="Leitura das UTMs no front (JavaScript)" />
            <p>
              <strong>3. Colocar as UTMs no metadata da Checkout Session.</strong> Em{" "}
              <C>metadata</C> e, nas assinaturas, também em <C>subscription_data.metadata</C>.
            </p>
            <CodeBlock code={SERVER_SNIPPET} label="Checkout Session com UTMs (servidor)" />
            <Bullets>
              <li>
                Opcional: <C>product_name</C> e <C>product_id</C> no metadata dão nome ao produto na
                venda.
              </li>
              <li>
                A Stripe aceita até 500 caracteres por valor; os snippets já cortam nesse limite.
              </li>
              <li>Não coloque e-mail, nome ou outros dados pessoais no metadata.</li>
            </Bullets>
          </Section>

          <Section
            id="conversions-api"
            title="Conversions API da Meta"
            provider="meta"
            lead="Manda as vendas do checkout para o pixel da Meta, que passa a otimizar as campanhas com as vendas reais. Configure em Integrações › Conversions API."
          >
            <Steps>
              {CAPI_GUIDE_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </Steps>
            <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
              {[
                ["Venda aprovada", "Purchase com valor, moeda, produto e o id do pedido."],
                [
                  "Renovação",
                  "Purchase com origem “gerada pelo sistema”: a Meta conta a receita, mas não credita a renovação ao último anúncio visto.",
                ],
                ["Teste iniciado", "StartTrial, sem valor (pode desligar)."],
                [
                  "Reembolso",
                  "Se a venda ainda não foi enviada, não vai mais. Se já foi, pode ir como o evento personalizado Refund (desligado por padrão).",
                ],
                [
                  "Duplicidade",
                  "O event_id é o id do pedido (pi_... na Stripe, o número do pedido na Kiwify). Se o pixel do site mandar o mesmo Purchase com esse eventID, a Meta conta uma vez só.",
                ],
                [
                  "Falhas",
                  "Erros temporários tentam de novo por até 12 horas; token ou pixel errados avisam no card e voltam a enviar assim que você salvar o token novo. A Meta só aceita eventos de até 7 dias.",
                ],
              ].map(([term, desc]) => (
                <div
                  key={term}
                  className="grid gap-1 px-3 py-2.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4"
                >
                  <dt className="font-medium text-foreground">{term}</dt>
                  <dd>{desc}</dd>
                </div>
              ))}
            </dl>
            <p>
              <strong>Dados do comprador:</strong> vai o e-mail só com hash SHA-256 (o nishiADS
              nunca guarda o e-mail em claro) e, quando o checkout repassa, os cookies <C>_fbc</C> e{" "}
              <C>_fbp</C> e o user agent. Com eles a Meta casa muito mais vendas com os cliques.
            </p>
            <CodeBlock
              code={CLICK_SNIPPET}
              label="Dados de clique para a Conversions API (JavaScript)"
            />
            <Bullets>
              <li>
                Kiwify: o webhook normalmente não traz os cookies da Meta, então a venda vai com o
                e-mail com hash. Se trouxer <C>fbclid</C> nos parâmetros de rastreamento, ele também
                é usado.
              </li>
              <li>Cada evento enviado, com a resposta da Meta, aparece em Logs de integração.</li>
            </Bullets>
          </Section>

          <Section
            id="status"
            title="Status de atribuição"
            lead="Cada venda mostra até onde a origem foi identificada."
          >
            <div className="grid gap-2 sm:grid-cols-3">
              {(Object.keys(ATTRIBUTION_META) as (keyof typeof ATTRIBUTION_META)[]).map((key) => (
                <div key={key} className="rounded-lg border border-border bg-surface p-3">
                  <Status tone={ATTRIBUTION_META[key].tone}>{ATTRIBUTION_META[key].label}</Status>
                  <p className="mt-2 text-sm leading-5">{ATTRIBUTION_META[key].description}</p>
                </div>
              ))}
            </div>
            <p>
              <strong>Parciais</strong> viram Atribuídas quando a conta de anúncios sincroniza
              (automático) ou com <strong>Refazer atribuição</strong> em {link("/vendas", "Vendas")}
              . <strong>Sem origem</strong> não tem conserto depois: as UTMs não chegaram ao
              checkout. Confira os parâmetros e o repasse para as próximas vendas.
            </p>
          </Section>

          <Section id="eventos" title="Reembolsos, renovações e testes">
            <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
              {[
                [
                  "Reembolso total",
                  "A venda muda para Reembolsada e sai da receita. Reembolso parcial mantém a venda aprovada.",
                ],
                ["Chargeback", "A venda muda para Chargeback e você recebe um alerta."],
                [
                  "Renovação (Stripe)",
                  "Cada cobrança paga entra como venda nova, atribuída ao anúncio da primeira compra.",
                ],
                [
                  "Teste grátis (Stripe)",
                  "Entra como Teste iniciado, já ligado ao anúncio e sem valor. Quando a primeira fatura é paga, vira venda aprovada, herda a origem e o teste passa a mostrar “Pagou”.",
                ],
                [
                  "Pix e boleto",
                  "Entram como Pendente e viram Aprovada quando o pagamento compensa.",
                ],
                [
                  "Evento repetido",
                  "Um mesmo evento recebido duas vezes não duplica a venda nem a notificação.",
                ],
              ].map(([term, desc]) => (
                <div
                  key={term}
                  className="grid gap-1 px-3 py-2.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4"
                >
                  <dt className="font-medium text-foreground">{term}</dt>
                  <dd>{desc}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section id="testar" title="Como testar">
            <Steps>
              <li>
                <strong>Webhook:</strong> no checkout, envie um evento de teste (Kiwify: Testar
                webhook; Stripe: abra um evento no destino e clique em Reenviar).
              </li>
              <li>
                Abra {link("/integracoes/logs", "Logs de integração")}. O evento deve aparecer como
                Processado. Se aparecer Recusado, o token ou o segredo está errado.
              </li>
              <li>
                <strong>UTMs:</strong> abra a sua página com UTMs de teste, por exemplo{" "}
                <C>?utm_campaign=Teste|1&amp;utm_content=Criativo|2</C>, e faça uma compra de teste.
                Em {link("/vendas", "Vendas")}, abra a venda: as UTMs aparecem no detalhe.
              </li>
              <li>
                Ative as notificações em {link("/ajustes/notificacoes", "Ajustes › Notificações")}{" "}
                para receber o push de cada venda.
              </li>
            </Steps>
          </Section>

          <Section id="problemas" title="Problemas comuns">
            <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
              {PROBLEMS.map(([symptom, fix]) => (
                <div
                  key={symptom}
                  className="grid gap-1 px-3 py-2.5 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-4"
                >
                  <dt className="font-medium text-foreground">{symptom}</dt>
                  <dd>{fix}</dd>
                </div>
              ))}
            </dl>
          </Section>
        </div>
      </div>
    </div>
  );
}
