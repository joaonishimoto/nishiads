import { describe, expect, it } from "vitest";
import { normalizeEventName, parseTrackBody } from "./event.ts";

const KEY = "a".repeat(64);

describe("eventos do rastreamento", () => {
  it("normaliza o nome do evento", () => {
    expect(normalizeEventName("Cadastro")).toBe("cadastro");
    expect(normalizeEventName(" Início de teste ")).toBe("inicio_de_teste");
    expect(normalizeEventName("!!!")).toBeNull();
    expect(normalizeEventName(42)).toBeNull();
  });

  it("lê o envio do script com a origem guardada", () => {
    const parsed = parseTrackBody(
      JSON.stringify({
        key: KEY,
        event: "cadastro",
        id: 123,
        event_id: "e1",
        visitor: "v1",
        touch: {
          utm_source: "FB",
          utm_content: "c4-c quanto de cachaca|120200000000001",
          fbclid: "abc",
          url: "https://drinfy.com/",
          at: "2026-10-29T12:00:00.000Z",
        },
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      key: KEY,
      event: {
        event: "cadastro",
        dedupe_key: "123",
        visitor_id: "v1",
        utm_source: "FB",
        utm_medium: null,
        utm_campaign: null,
        utm_content: "c4-c quanto de cachaca|120200000000001",
        utm_term: null,
        fbclid: "abc",
        landing_url: "https://drinfy.com/",
        touched_at: "2026-10-29T12:00:00.000Z",
      },
    });
  });

  it("sem id do app, usa o id do envio; sem origem, vai sem UTM", () => {
    const parsed = parseTrackBody(
      JSON.stringify({ key: KEY, event: "lead", event_id: "e1", touch: null }),
    );
    expect(parsed.ok && parsed.event.dedupe_key).toBe("e1");
    expect(parsed.ok && parsed.event.utm_content).toBeNull();
  });

  it("recusa o que não é do script", () => {
    expect(parseTrackBody("não é json")).toEqual({ ok: false, error: "invalid_body" });
    expect(parseTrackBody(JSON.stringify({ key: "x", event: "cadastro", event_id: "e" }))).toEqual({
      ok: false,
      error: "invalid_key",
    });
    expect(parseTrackBody(JSON.stringify({ key: KEY, event: "", event_id: "e" }))).toEqual({
      ok: false,
      error: "invalid_event",
    });
    expect(parseTrackBody(JSON.stringify({ key: KEY, event: "cadastro" }))).toEqual({
      ok: false,
      error: "missing_id",
    });
    expect(parseTrackBody("x".repeat(9_000))).toEqual({ ok: false, error: "payload_too_large" });
  });
});
