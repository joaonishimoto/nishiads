import { describe, expect, it } from "vitest";
import { trackedRegistrationPayload } from "./messages.ts";

const base = {
  id: 7,
  workspace_id: "w1",
  source_name: "Drinfy",
  campaign_name: null,
  ad_name: null,
  utm_content: null,
  utm_source: null,
};

describe("push de cadastro do rastreamento", () => {
  it("mostra campanha e criativo quando o anúncio foi encontrado", () => {
    expect(
      trackedRegistrationPayload({
        ...base,
        campaign_name: "Cadastros",
        ad_name: "c4-c quanto de cachaca",
      }),
    ).toEqual({
      title: "📝 Novo cadastro · Drinfy",
      body: "Cadastros › c4-c quanto de cachaca",
      url: "/w/w1/campanhas",
      tag: "tracked_registration:7",
    });
  });

  it("usa o nome do UTM quando o anúncio ainda não sincronizou", () => {
    expect(
      trackedRegistrationPayload({ ...base, utm_content: "Novo criativo|1204000099" }).body,
    ).toBe("Novo criativo (anúncio ainda não sincronizado)");
  });

  it("diz quando não veio de anúncio", () => {
    expect(trackedRegistrationPayload(base).body).toBe(
      "Sem anúncio: orgânico, direto ou link sem UTM",
    );
    expect(trackedRegistrationPayload({ ...base, utm_source: "instagram" }).body).toBe(
      "Veio de instagram, sem anúncio identificado",
    );
  });
});
