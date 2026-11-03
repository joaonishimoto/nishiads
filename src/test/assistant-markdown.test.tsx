import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/features/assistant/markdown";

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown do assistente", () => {
  it("monta tabelas em vez de mostrar as barras", () => {
    const html = render("| Campanha | ROAS |\n|---|---|\n| Reels | 3,10 |");
    expect(html).toContain("<table");
    expect(html).toContain("<td");
    expect(html).not.toContain("|---|");
  });

  it("mantém listas aninhadas e a numeração", () => {
    const html = render("1. Primeira\n   - detalhe\n2. Segunda");
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html).toContain("<ul");
  });

  it("entende itálico, código, citação e linha", () => {
    const html = render("*R$ 252* e `R$ 100`\n\n> Atenção\n\n---");
    expect(html).toContain("<em");
    expect(html).toContain("<code");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<hr");
  });

  it("não interpreta HTML vindo do modelo", () => {
    const html = render('Oi <img src=x onerror="alert(1)"> <script>alert(1)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });
});
