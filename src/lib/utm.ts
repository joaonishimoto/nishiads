/** "Nome da campanha|1202..." → { name, id }. Espelha private.split_utm_ref do banco. */
export function splitUtmRef(value: string | null | undefined): { name: string | null; id: string | null } {
  if (!value) return { name: null, id: null };
  const text = value.trim();
  if (/^\d{6,}$/.test(text)) return { name: null, id: text };
  const match = /\|\s*(\d+)\s*$/.exec(text);
  const name = (match ? text.slice(0, match.index) : text).trim() || null;
  return { name, id: match?.[1] ?? null };
}

/** String para o campo "Parâmetros de URL" do anúncio na Meta. */
export const META_URL_PARAMETERS =
  "utm_source=FB&utm_campaign={{campaign.name}}|{{campaign.id}}&utm_medium={{adset.name}}|{{adset.id}}&utm_content={{ad.name}}|{{ad.id}}&utm_term={{placement}}";
