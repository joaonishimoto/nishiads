import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { env } from "@/lib/env";
import type { DateRange } from "@/lib/period";
import type { AttributionStatus, Tables } from "@/types/database";

export type TrackingSource = Pick<
  Tables<"tracking_sources">,
  "id" | "name" | "public_key" | "active" | "last_event_at" | "created_at"
>;

/** Evento do script, só o que as métricas usam. */
export type TrackingEvent = {
  event: string;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  attribution_status: AttributionStatus;
  occurred_at: string;
};

export const trackingKeys = {
  sources: (workspaceId: string) => ["tracking", workspaceId, "sources"] as const,
  events: (workspaceId: string, range: DateRange) =>
    ["tracking", workspaceId, "events", range] as const,
  summary: (workspaceId: string) => ["tracking", workspaceId, "summary"] as const,
};

export function trackEndpoint(): string {
  return `${env?.VITE_SUPABASE_URL ?? ""}/functions/v1/track`;
}

/** Código para colar no <head> do site ou app. */
export function trackingSnippet(publicKey: string, origin = window.location.origin): string {
  return (
    `<script>window.nishistack=window.nishistack||function(){(nishistack.q=nishistack.q||[]).push(arguments)};</script>\n` +
    `<script async src="${origin}/nishistack-ads.js" data-key="${publicKey}" data-endpoint="${trackEndpoint()}"></script>`
  );
}

export function useTrackingSources(workspaceId: string) {
  return useQuery({
    queryKey: trackingKeys.sources(workspaceId),
    queryFn: async (): Promise<TrackingSource[]> => {
      const { data, error } = await supabase
        .from("tracking_sources")
        .select("id, name, public_key, active, last_event_at, created_at")
        .eq("workspace_id", workspaceId)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCreateTrackingSource(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const { data, error } = await supabase.rpc("create_tracking_source", {
        p_workspace_id: workspaceId,
        p_name: name,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: trackingKeys.sources(workspaceId) }),
  });
}

export function useUpdateTrackingSource(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: { id: string; active?: boolean; name?: string }) => {
      const { id, ...patch } = values;
      const { error } = await supabase.from("tracking_sources").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: trackingKeys.sources(workspaceId) }),
  });
}

export function useDeleteTrackingSource(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("tracking_sources").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tracking", workspaceId] }),
  });
}

const PAGE = 1000;

/** Eventos do período (cadastros, testes...) com o anúncio de origem. */
export function useTrackingEvents(workspaceId: string, range: DateRange, enabled = true) {
  return useQuery({
    queryKey: trackingKeys.events(workspaceId, range),
    enabled,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<TrackingEvent[]> => {
      const rows: TrackingEvent[] = [];
      for (let i = 0; ; i++) {
        const { data, error } = await supabase
          .from("tracking_events")
          .select("event, campaign_id, adset_id, ad_id, attribution_status, occurred_at")
          .eq("workspace_id", workspaceId)
          .gte("occurred_at", range.from)
          .lt("occurred_at", range.to)
          .order("occurred_at")
          .order("id")
          .range(i * PAGE, i * PAGE + PAGE - 1);
        if (error) throw error;
        rows.push(...(data ?? []));
        if ((data ?? []).length < PAGE) return rows;
      }
    },
  });
}

export type TrackingSummaryRow = { event: string; total: number; matched: number; last: string };

/** Eventos dos últimos 7 dias por nome, para o painel conferir a instalação. */
export function useTrackingSummary(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: trackingKeys.summary(workspaceId),
    enabled,
    queryFn: async (): Promise<TrackingSummaryRow[]> => {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("tracking_events")
        .select("event, attribution_status, occurred_at")
        .eq("workspace_id", workspaceId)
        .gte("occurred_at", since)
        .order("occurred_at", { ascending: false })
        .limit(PAGE);
      if (error) throw error;
      const byEvent = new Map<string, TrackingSummaryRow>();
      for (const e of data ?? []) {
        const row = byEvent.get(e.event) ?? {
          event: e.event,
          total: 0,
          matched: 0,
          last: e.occurred_at,
        };
        row.total++;
        if (e.attribution_status === "matched") row.matched++;
        byEvent.set(e.event, row);
      }
      return [...byEvent.values()].sort((a, b) => b.total - a.total);
    },
  });
}
