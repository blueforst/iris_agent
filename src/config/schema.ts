export interface AgentConfigV3 {
  config_version: 3;
  instance_name: string;
  persona?: PersonaConfig;
  runtime_sessions: RuntimeSessionsConfig;
  context?: ContextConfig;
  model: ModelConfig;
  historian?: HistorianConfig;
  memory_client?: MemoryClientConfig;
  tools?: ToolsConfig;
  body?: BodyConfig;
  host: HostConfig;
  observability: ObservabilityConfig;
}

export interface PersonaConfig {
  soul_path?: string;
  sqlite_path?: string;
  mode?: "authored";
  auto_activation_enabled?: boolean;
  persona_token_ratio?: number;
}

export interface RuntimeSessionsConfig {
  sqlite_path: string;
  epoch_registry_sqlite_path: string;
  payload_index_sqlite_path?: string;
  timezone: string;
  rollover: RuntimeRolloverConfig;
  archive?: RuntimeArchiveConfig;
  session_id_prefix: string;
  pi_input_persistence_mode: "pi_user_with_iris_meta_companion";
  provenance_storage: "pi_details";
  allow_fallback_sidecar: false;
  inline_payload_max_bytes?: number;
  blob_root?: string;
  input_payload?: InputPayloadConfig;
  verify_on_startup?: "active_epoch_and_session";
  pi_compaction_mode: "forbidden_in_m1";
}

export interface RuntimeRolloverConfig {
  daily_enabled: boolean;
  only_after_settled: boolean;
  max_entries: number;
  max_estimated_tokens: number;
  max_sqlite_bytes_per_session: number;
  max_build_context_p95_ms: number;
  max_process_rss_bytes: number;
  limits_status: "provisional_until_locked_pi_benchmark";
  allow_multiple_epochs_per_day: boolean;
  wrapup_wait_timeout_seconds: number;
}

export interface RuntimeArchiveConfig {
  retain_closed_sessions: boolean;
  default_list_limit: number;
  overlap_max_projection_units: number;
  overlap_max_tokens: number;
  overlap_max_bytes: number;
}

export interface InputPayloadConfig {
  original_max_bytes?: number;
  inline_text_max_bytes?: number;
  external_ref_preview_max_bytes?: number;
  provider_projection_max_bytes?: number;
  provider_projection_max_dimension?: number;
  encoder_version?: string;
  allowed_mime_types?: string[];
}

export interface ContextConfig {
  sqlite_path?: string;
  budget?: ContextBudgetConfig;
  materialization?: ContextMaterializationConfig;
  p3?: ContextP3Config;
  p4?: ContextP4Config;
  p5?: ContextP5Config;
}

export interface ContextBudgetConfig {
  authority_profile?: "magic_context_opencode_v0.33.0";
  authority_commit?: string;
  execute_threshold_percentage?: number;
  history_budget_percentage?: number;
  max_execute_threshold_percentage?: number;
}

export interface ContextMaterializationConfig {
  authority_profile?: "magic_context_opencode";
  layout?: "magic_context_m0_m1";
  replay_mode?: "byte_stable";
  context_serializer_version?: string;
  carrier_schema_version?: string;
  golden_fixture_profile?: "opencode_v0.33.0";
}

export interface ContextP3Config {
  compartment_schema_version?: "magic_context_opencode_v2";
  decay_renderer_profile?: "opencode_v0.33.0";
}

export interface ContextP4Config {
  stable?: { max_items?: number; mutation_profile?: string };
  query_recall?: {
    enabled?: boolean;
    timeout_ms?: number;
    max_items?: number;
    max_rendered_tokens?: number;
    min_query_chars?: number;
  };
}

export interface ContextP5Config {
  current_session_max_entries?: number;
  previous_session_overlap_max_units?: number;
  previous_session_overlap_max_tokens?: number;
  require_source_session_and_range_hash?: boolean;
}

export interface ModelConfig {
  main_agent: MainAgentConfig;
  historian?: HistorianModelConfig;
}

export interface MainAgentConfig {
  active_profile: string;
  profiles: Record<string, MainAgentProfile>;
  test_budgets?: MainAgentTestBudgets;
  verified_model_metadata?: VerifiedModelMetadata;
}

export interface MainAgentProfile {
  provider: "opencode-go";
  protocol: "openai-chat-completions";
  base_url: string;
  model: string;
  api_key_env: string;
  thinking: { type: "disabled" | "enabled"; reasoning_effort?: string };
  max_output_tokens: number;
  development_only: true;
}

export interface MainAgentTestBudgets {
  thinking_stress_max_output_tokens?: number;
  thinking_stress_schedule?: "manual_or_nightly_only";
  truncation_fixture_max_output_tokens?: number[];
}

export interface VerifiedModelMetadata {
  provider: string;
  model: string;
  context_window: number;
  max_output_tokens: number;
  source: "provider_official_documentation";
  verified_at: string;
}

export interface HistorianModelConfig {
  provider?: string;
  model?: string;
  max_output_tokens?: number;
  request_timeout_seconds?: number;
  repair_pass_enabled?: boolean;
}

export interface HistorianConfig {
  sqlite_path?: string;
  outbox?: {
    delivery_batch_size?: number;
    claim_timeout_seconds?: number;
    retry_initial_seconds?: number;
    retry_max_seconds?: number;
    max_attempts_before_quarantine?: number;
  };
  protected_tail?: {
    boundary_policy_profile?: "magic_context_opencode_v3";
    max_scan_projection_units?: number;
    max_scan_bytes?: number;
  };
  queue?: { mode?: "single_global"; max_pending_jobs?: number };
}

export interface MemoryClientConfig {
  router_base_url?: string;
  request_timeout_ms?: number;
}

export interface ToolsConfig {
  sqlite_path?: string;
  recovery_blob_root?: string;
  recovery_retention_after_journal_ack_seconds?: number;
  tool_wrapper_execution_mode?: "sequential";
  local_host_mutation_gate?: {
    enabled?: true;
    intent_mode?: "structured_direct_action_only";
    protected_scopes?: Array<
      "workspace_write" | "iris_data_root" | "iris_runtime_control" | "arbitrary_host_write"
    >;
  };
}

export interface BodyConfig {
  enabled?: boolean;
  adapters?: string[];
  event_queue_max?: number;
}

export interface HostConfig {
  mode: "cli";
  http: { bind_host?: string; port?: number; remote_access?: false };
  origin?: { principal_ref_log_mode?: "hash" };
  input_queue_max?: number;
  shutdown_grace_ms?: number;
  data_root_lock: { enabled: true; path: string; mode: "os_exclusive_fail_fast" };
  ingress: {
    sqlite_path: string;
    blob_root: string;
    dedupe_key?: "instance_epoch_plus_input_id";
    payload_hash_required?: true;
    states?: Array<"accepted" | "session_committed" | "rejected">;
  };
}

export interface ObservabilityConfig {
  log_level: "debug" | "info" | "warn" | "error";
  json_logs: true;
  metrics_enabled?: boolean;
  tracing_enabled?: boolean;
  redact_sensitive_fields?: true;
}
