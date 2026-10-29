/** Push de cadastro do rastreamento próprio. Função pura, testada em messages.test.ts. */
import type { PushPayload } from "../notify/messages.ts";

export interface TrackedRegistration {
  id: number;
  workspace_id: string;
  source_name: string;
  campaign_name: string | null;
  ad_name: string | null;
  utm_content: string | null;
  utm_source: string | null;
}

/** "Nome do anúncio|1202..." → "Nome do anúncio" (o id não ajuda no celular). */
function utmName(value: string | null): string | null {
  const name = value?.replace(/\|\s*\d+\s*$/, "").trim();
  return name && !/^\d+$/.test(name) ? name : null;
}

export function trackedRegistrationPayload(r: TrackedRegistration): PushPayload {
  const origin =
    [r.campaign_name, r.ad_name].filter(Boolean).join(" › ") ||
    (utmName(r.utm_content)
      ? `${utmName(r.utm_content)} (anúncio ainda não sincronizado)`
      : null) ||
    (r.utm_source
      ? `Veio de ${r.utm_source}, sem anúncio identificado`
      : "Sem anúncio: orgânico, direto ou link sem UTM");
  return {
    title: `📝 Novo cadastro · ${r.source_name}`,
    body: origin,
    url: `/w/${r.workspace_id}/campanhas`,
    tag: `tracked_registration:${r.id}`,
  };
}
