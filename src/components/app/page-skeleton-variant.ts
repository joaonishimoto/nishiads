export type PageSkeletonVariant =
  "table" | "cards" | "library" | "board" | "overview" | "detail" | "settings";

/** Picks the loading placeholder that mirrors the layout of the area being opened. */
export function skeletonVariantForPath(pathname: string): PageSkeletonVariant {
  const segments = pathname.split("/").filter(Boolean);
  const [area, id] = segments;
  if (!area) return "overview";
  if (id && ["crm", "clientes", "propostas", "projetos"].includes(area)) return "detail";
  if (area === "crm") return "board";
  if (
    area === "metas" ||
    area === "paginas-html" ||
    area === "conectores" ||
    (area === "catalogo" && id === "landing-page")
  )
    return "cards";
  if (area === "documentacao") return "library";
  if (area === "configuracoes") return "settings";
  return "table";
}
