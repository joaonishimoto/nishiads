import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { DailySummaryPeriod, Tables } from "@/types/database";
import type { DailySummaryNumbers } from "../../../supabase/functions/_shared/daily-summary/template";

export type DailySummarySettings = Tables<"daily_summary_settings">;

export const dailySummaryKeys = {
  settings: (workspaceId: string, userId: string) =>
    ["daily-summary", workspaceId, userId] as const,
  numbers: (workspaceId: string, period: DailySummaryPeriod) =>
    ["daily-summary", workspaceId, "numbers", period] as const,
};

export function useDailySummarySettings(workspaceId: string, userId: string) {
  return useQuery({
    queryKey: dailySummaryKeys.settings(workspaceId, userId),
    queryFn: async (): Promise<DailySummarySettings | null> => {
      const { data, error } = await supabase
        .from("daily_summary_settings")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export type DailySummaryPatch = Pick<
  DailySummarySettings,
  "enabled" | "send_time" | "period" | "title_template" | "body_template"
>;

export function useSaveDailySummary(workspaceId: string, userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: Partial<DailySummaryPatch>) => {
      const { error } = await supabase
        .from("daily_summary_settings")
        .upsert(
          { workspace_id: workspaceId, user_id: userId, ...values },
          { onConflict: "workspace_id,user_id" },
        );
      if (error) throw error;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: dailySummaryKeys.settings(workspaceId, userId) }),
  });
}

/** Números de hoje (até agora) ou de ontem, para a prévia do texto. */
export function useDailySummaryNumbers(
  workspaceId: string,
  period: DailySummaryPeriod,
  enabled = true,
) {
  return useQuery({
    queryKey: dailySummaryKeys.numbers(workspaceId, period),
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<DailySummaryNumbers> => {
      const { data, error } = await supabase.rpc("daily_summary_numbers", {
        p_workspace_id: workspaceId,
        p_period: period,
      });
      if (error) throw error;
      return data as unknown as DailySummaryNumbers;
    },
  });
}

type TestResponse = { sent?: number; delivered?: number; error?: string };

/** Manda o resumo agora, só para você, com o texto do editor (mesmo sem salvar). */
export function useSendDailySummaryTest(workspaceId: string) {
  return useMutation({
    mutationFn: async (
      values: Pick<DailySummaryPatch, "period" | "title_template" | "body_template">,
    ) => {
      const { data, error } = await supabase.functions.invoke<TestResponse>("daily-summary", {
        body: { action: "test", workspace_id: workspaceId, ...values },
      });
      if (error) {
        const context = (error as { context?: Response }).context;
        const payload = context
          ? ((await context.json().catch(() => null)) as TestResponse | null)
          : null;
        if (payload?.error === "push_not_configured") throw new Error("push_not_configured");
        throw error;
      }
      return { sent: data?.sent ?? 0, delivered: data?.delivered ?? 0 };
    },
  });
}
