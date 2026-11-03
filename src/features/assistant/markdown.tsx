import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Markdown das respostas do assistente: parágrafos, listas (inclusive aninhadas), títulos,
 * **negrito**, *itálico*, `código`, citações, linhas e tabelas. O HTML cru que vier do modelo
 * não é interpretado (react-markdown só gera elementos React), e links abrem em outra aba.
 */
const components: Components = {
  h1: ({ children }) => <h3 className="pt-1 text-base font-semibold text-foreground">{children}</h3>,
  h2: ({ children }) => <h3 className="pt-1 text-base font-semibold text-foreground">{children}</h3>,
  h3: ({ children }) => <h4 className="pt-1 text-sm font-semibold text-foreground">{children}</h4>,
  h4: ({ children }) => <h4 className="pt-1 text-sm font-semibold text-foreground">{children}</h4>,
  h5: ({ children }) => <h4 className="pt-1 text-sm font-semibold text-foreground">{children}</h4>,
  h6: ({ children }) => <h4 className="pt-1 text-sm font-semibold text-foreground">{children}</h4>,
  p: ({ children }) => <p>{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>,
  ol: ({ children }) => (
    <ol className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-0.5 [&>ol]:mt-1 [&>ul]:mt-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="rounded-md border-l-2 border-warning bg-warning/8 px-3 py-2 text-foreground [&>p]:m-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border" />,
  code: ({ children }) => (
    <code className="rounded bg-surface-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md bg-surface-muted p-3 text-xs [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-medium text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-max border-collapse text-left text-[13px] tabular-nums">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border-strong">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-border last:border-0">{children}</tr>,
  th: ({ children, style }) => (
    <th
      style={style}
      className="px-2 py-1.5 font-medium whitespace-nowrap text-muted-foreground first:pl-0"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="px-2 py-1.5 align-top first:pl-0">
      {children}
    </td>
  ),
  img: () => null,
};

export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "space-y-3 text-sm leading-6 break-words text-foreground [&_li>p]:m-0",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
