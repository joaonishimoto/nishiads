// Tipos do banco no formato do `supabase gen types typescript`.
// Ao mudar uma migration, regenere com:
//   npx supabase gen types typescript --project-id <id> --schema public > src/types/database.ts

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Timestamps = { created_at: string; updated_at: string };

export type WorkspaceRole = "owner" | "admin" | "viewer";
export type AdPlatform = "meta";
export type AdAccountStatus = "active" | "needs_reconnect" | "disabled" | "error";
export type MetaConnectionStatus = "active" | "needs_reconnect";
export type CheckoutProvider = "kiwify" | "hotmart" | "stripe" | "eduzz" | "generic";
export type SaleStatus = "approved" | "pending" | "refunded" | "chargeback" | "canceled" | "trialing";
export type AttributionStatus = "matched" | "partial" | "unattributed";
export type NotificationChannel = "webpush" | "telegram";
export type WebhookEventStatus = "received" | "processed" | "ignored" | "rejected" | "failed";

type ProfileRow = Timestamps & { id: string; email: string; full_name: string | null };

type WorkspaceRow = Timestamps & {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  created_by: string | null;
};

type WorkspaceMemberRow = {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
};

type WorkspaceInvitationRow = {
  id: string;
  workspace_id: string;
  email: string;
  role: WorkspaceRole;
  invited_by: string | null;
  created_at: string;
};

type AdAccountRow = Timestamps & {
  id: string;
  workspace_id: string;
  platform: AdPlatform;
  external_id: string;
  name: string;
  currency: string;
  timezone: string | null;
  status: AdAccountStatus;
  is_tracked: boolean;
  token_ref: string | null;
  token_expires_at: string | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
  backfilled_at: string | null;
  connected_by: string | null;
  meta_connection_id: string | null;
  sync_started_at: string | null;
  rate_limited_until: string | null;
};

type MetaConnectionRow = Timestamps & {
  id: string;
  workspace_id: string;
  meta_user_id: string;
  meta_user_name: string | null;
  token_ref: string | null;
  token_expires_at: string | null;
  scopes: string[];
  status: MetaConnectionStatus;
  last_error: string | null;
  connected_by: string | null;
};

type AdEntityBase = Timestamps & {
  id: string;
  workspace_id: string;
  ad_account_id: string;
  external_id: string;
  name: string;
  status: string | null;
  effective_status: string | null;
};

/** Orçamento em centavos; nulo no nível que não guarda orçamento (CBO × conjunto). */
type BudgetColumns = { daily_budget_cents: number | null; lifetime_budget_cents: number | null };
type CampaignRow = AdEntityBase & BudgetColumns & { objective: string | null };
type AdsetRow = AdEntityBase & BudgetColumns & { campaign_id: string };

export type MetaActionLevel = "campaign" | "adset" | "ad";
export type MetaActionKind = "pause" | "activate" | "set_budget";

type MetaActionLogRow = {
  id: string;
  workspace_id: string;
  ad_account_id: string | null;
  level: MetaActionLevel;
  object_id: string;
  external_id: string;
  object_name: string | null;
  action: MetaActionKind;
  previous: Json | null;
  requested: Json;
  ok: boolean;
  error: string | null;
  source: "manual" | "rule";
  actor_user_id: string | null;
  context: Json;
  created_at: string;
};
type AdRow = AdEntityBase & {
  campaign_id: string;
  adset_id: string;
  creative_id: string | null;
  thumbnail_url: string | null;
  preview_link: string | null;
};

type AdInsightDailyRow = {
  ad_id: string;
  date: string;
  workspace_id: string;
  ad_account_id: string;
  currency: string;
  spend_cents: number;
  impressions: number;
  reach: number;
  clicks: number;
  link_clicks: number;
  ctr: number | null;
  cpc_cents: number | null;
  cpm_cents: number | null;
  synced_at: string;
};

type CheckoutIntegrationRow = Timestamps & {
  id: string;
  workspace_id: string;
  provider: CheckoutProvider;
  name: string;
  webhook_secret_ref: string | null;
  webhook_url_token: string;
  active: boolean;
  last_event_at: string | null;
  created_by: string | null;
};

type ProductRow = Timestamps & {
  id: string;
  workspace_id: string;
  provider: CheckoutProvider | null;
  external_product_id: string | null;
  name: string;
  cost_cents: number;
  fee_percent_bps: number;
  fee_fixed_cents: number;
};

type SaleRow = Timestamps & {
  id: string;
  workspace_id: string;
  checkout_integration_id: string | null;
  provider: CheckoutProvider;
  external_order_id: string;
  status: SaleStatus;
  gross_amount_cents: number;
  net_amount_cents: number | null;
  currency: string;
  product_id: string | null;
  external_product_id: string | null;
  product_name: string | null;
  customer_email_hash: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  attribution_status: AttributionStatus;
  paid_at: string | null;
  refunded_at: string | null;
  /** Teste: quando a primeira cobrança paga chegou. */
  trial_converted_at: string | null;
  /** Teste: a venda aprovada em que ele se converteu. */
  converted_sale_id: string | null;
  raw_payload: Json;
};

type WebhookEventRow = {
  id: number;
  workspace_id: string;
  checkout_integration_id: string | null;
  provider: CheckoutProvider;
  status: WebhookEventStatus;
  event_type: string | null;
  external_order_id: string | null;
  sale_id: string | null;
  error: string | null;
  payload: Json;
  attempts: number;
  received_at: string;
  processed_at: string | null;
};

type NotificationSubscriptionRow = Timestamps & {
  id: string;
  workspace_id: string;
  user_id: string;
  channel: NotificationChannel;
  endpoint: string | null;
  config: Json;
  active: boolean;
  user_agent: string | null;
  last_used_at: string | null;
};

type NotificationPreferencesRow = {
  workspace_id: string;
  user_id: string;
  notify_approved: boolean;
  notify_refunded: boolean;
  notify_chargeback: boolean;
  min_amount_cents: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  sound_enabled: boolean;
  notify_alerts: boolean;
  updated_at: string;
};

export type AlertCondition = "spend_without_sale" | "roas_below" | "cpa_above";
export type AlertLevel = "campaign" | "adset" | "ad";
export type AlertWindow = "today" | "last_3d" | "last_7d";
export type AlertAction = "notify" | "approve_pause" | "auto_pause";
export type AlertStatus = "notified" | "pending" | "pausing" | "paused" | "dismissed" | "expired";

type AlertRuleRow = Timestamps & {
  id: string;
  workspace_id: string;
  name: string;
  enabled: boolean;
  condition: AlertCondition;
  level: AlertLevel;
  time_window: AlertWindow;
  threshold_cents: number | null;
  /** numeric: o PostgREST devolve como número. */
  min_roas: number | null;
  min_spend_cents: number;
  action: AlertAction;
  max_auto_pauses_per_day: number;
  ad_account_id: string | null;
  campaign_id: string | null;
  created_by: string | null;
  last_evaluated_at: string | null;
};

type AlertRow = Timestamps & {
  id: string;
  workspace_id: string;
  rule_id: string | null;
  rule_name: string;
  condition: AlertCondition;
  level: AlertLevel;
  time_window: AlertWindow;
  action: AlertAction;
  threshold_cents: number | null;
  min_roas: number | null;
  ad_account_id: string;
  object_id: string;
  object_external_id: string;
  object_name: string;
  period_key: string;
  currency: string;
  spend_cents: number;
  sales: number;
  revenue_cents: number;
  roas: number | null;
  cpa_cents: number | null;
  status: AlertStatus;
  auto_action: boolean;
  error: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  push_recipients: number;
  push_delivered: number;
};

/** Tabela sem escrita pelo app: Insert/Update existem só para tipagem da service_role. */
type Table<Row, Required extends keyof Row, Relationships extends unknown[] = []> = {
  Row: Row;
  Insert: Pick<Row, Required> & Partial<Omit<Row, Required>>;
  Update: Partial<Row>;
  Relationships: Relationships;
};

export type Database = {
  public: {
    Tables: {
      profiles: Table<ProfileRow, "id" | "email">;
      workspaces: Table<WorkspaceRow, "name">;
      workspace_members: Table<
        WorkspaceMemberRow,
        "workspace_id" | "user_id",
        [
          {
            foreignKeyName: "workspace_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ]
      >;
      workspace_invitations: Table<WorkspaceInvitationRow, "workspace_id" | "email">;
      ad_accounts: Table<AdAccountRow, "workspace_id" | "external_id" | "name">;
      meta_connections: Table<MetaConnectionRow, "workspace_id" | "meta_user_id">;
      campaigns: Table<CampaignRow, "workspace_id" | "ad_account_id" | "external_id" | "name">;
      adsets: Table<AdsetRow, "workspace_id" | "ad_account_id" | "campaign_id" | "external_id" | "name">;
      ads: Table<
        AdRow,
        "workspace_id" | "ad_account_id" | "campaign_id" | "adset_id" | "external_id" | "name"
      >;
      meta_action_log: Table<
        MetaActionLogRow,
        "workspace_id" | "level" | "object_id" | "external_id" | "action" | "ok",
        [
          {
            foreignKeyName: "meta_action_log_actor_user_id_fkey";
            columns: ["actor_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ]
      >;
      ad_insights_daily: Table<AdInsightDailyRow, "ad_id" | "date" | "workspace_id" | "ad_account_id">;
      checkout_integrations: Table<CheckoutIntegrationRow, "workspace_id" | "provider" | "name">;
      products: Table<ProductRow, "workspace_id" | "name">;
      sales: Table<
        SaleRow,
        "workspace_id" | "provider" | "external_order_id" | "status" | "gross_amount_cents",
        [
          {
            foreignKeyName: "sales_campaign_id_workspace_id_fkey";
            columns: ["campaign_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id", "workspace_id"];
          },
          {
            foreignKeyName: "sales_adset_id_workspace_id_fkey";
            columns: ["adset_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "adsets";
            referencedColumns: ["id", "workspace_id"];
          },
          {
            foreignKeyName: "sales_ad_id_workspace_id_fkey";
            columns: ["ad_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "ads";
            referencedColumns: ["id", "workspace_id"];
          },
          {
            foreignKeyName: "sales_checkout_integration_id_workspace_id_fkey";
            columns: ["checkout_integration_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "checkout_integrations";
            referencedColumns: ["id", "workspace_id"];
          },
        ]
      >;
      webhook_events: Table<
        WebhookEventRow,
        "workspace_id" | "provider" | "payload",
        [
          {
            foreignKeyName: "webhook_events_checkout_integration_id_workspace_id_fkey";
            columns: ["checkout_integration_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "checkout_integrations";
            referencedColumns: ["id", "workspace_id"];
          },
        ]
      >;
      notification_subscriptions: Table<
        NotificationSubscriptionRow,
        "workspace_id" | "user_id" | "channel"
      >;
      notification_preferences: Table<NotificationPreferencesRow, "workspace_id" | "user_id">;
      alert_rules: Table<AlertRuleRow, "workspace_id" | "name" | "condition" | "level">;
      alerts: Table<
        AlertRow,
        | "workspace_id"
        | "rule_name"
        | "condition"
        | "level"
        | "time_window"
        | "action"
        | "ad_account_id"
        | "object_id"
        | "object_external_id"
        | "object_name"
        | "period_key"
        | "currency"
        | "spend_cents"
        | "sales"
        | "revenue_cents"
        | "status"
      >;
    };
    Views: { [_ in never]: never };
    Functions: {
      create_workspace: {
        Args: { p_name: string; p_timezone?: string; p_currency?: string };
        Returns: WorkspaceRow;
      };
      invite_workspace_member: {
        Args: { p_workspace_id: string; p_email: string; p_role?: WorkspaceRole };
        Returns: "added" | "invited" | "already_member";
      };
      update_workspace_member_role: {
        Args: { p_workspace_id: string; p_user_id: string; p_role: WorkspaceRole };
        Returns: undefined;
      };
      remove_workspace_member: {
        Args: { p_workspace_id: string; p_user_id: string };
        Returns: undefined;
      };
      create_checkout_integration: {
        Args: {
          p_workspace_id: string;
          p_provider: CheckoutProvider;
          p_name: string;
          p_webhook_secret?: string | null;
        };
        Returns: CheckoutIntegrationRow;
      };
      disconnect_meta_connection: {
        Args: { p_connection_id: string };
        Returns: undefined;
      };
      reattribute_sales: {
        Args: { p_workspace_id: string };
        Returns: number;
      };
      set_checkout_integration_secret: {
        Args: { p_integration_id: string; p_webhook_secret: string };
        Returns: undefined;
      };
      register_push_subscription: {
        Args: {
          p_workspace_id: string;
          p_endpoint: string;
          p_p256dh: string;
          p_auth: string;
          p_user_agent?: string | null;
        };
        Returns: string;
      };
      preview_alert_rule: {
        Args: {
          p_workspace_id: string;
          p_condition: AlertCondition;
          p_level: AlertLevel;
          p_time_window: AlertWindow;
          p_threshold_cents: number | null;
          p_min_roas: number | null;
          p_min_spend_cents: number;
          p_ad_account_id?: string | null;
          p_campaign_id?: string | null;
        };
        Returns: {
          object_id: string;
          object_name: string;
          spend_cents: number;
          sales: number;
          revenue_cents: number;
          roas: number | null;
          cpa_cents: number | null;
        }[];
      };
      dismiss_alert: {
        Args: { p_alert_id: string };
        Returns: undefined;
      };
    };
    Enums: {
      workspace_role: WorkspaceRole;
      ad_platform: AdPlatform;
      ad_account_status: AdAccountStatus;
      meta_connection_status: MetaConnectionStatus;
      checkout_provider: CheckoutProvider;
      sale_status: SaleStatus;
      attribution_status: AttributionStatus;
      notification_channel: NotificationChannel;
      webhook_event_status: WebhookEventStatus;
    };
    CompositeTypes: { [_ in never]: never };
  };
};

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
