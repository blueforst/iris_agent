import { readFile } from "node:fs/promises";

import { Ajv2020 } from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";

import agentSchema from "./agent.schema.json" with { type: "json" };
import type { AgentConfigV3 } from "./schema.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = formatsPlugin as unknown as (validator: Ajv2020) => void;
addFormats(ajv);
const validateAgentConfig = ajv.compile(agentSchema);

export class ConfigValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`agent.json validation failed: ${errors.join("; ")}`);
    this.name = "ConfigValidationError";
  }
}

export function parseAgentConfig(value: unknown): AgentConfigV3 {
  if (!validateAgentConfig(value)) {
    const errors = (validateAgentConfig.errors ?? []).map((error) => {
      const instancePath = error.instancePath;
      const message = error.message;
      return `${instancePath} ${message ?? "invalid"}`;
    });
    throw new ConfigValidationError(errors);
  }
  return value as unknown as AgentConfigV3;
}

export async function loadAgentConfig(filePath: string): Promise<AgentConfigV3> {
  const raw = await readFile(filePath, "utf8");
  return parseAgentConfig(JSON.parse(raw) as unknown);
}

export function defaultAgentConfig(overrides: Partial<AgentConfigV3> = {}): AgentConfigV3 {
  return parseAgentConfig({
    config_version: 3,
    instance_name: "iris-main",
    runtime_sessions: {
      sqlite_path: "./session.db",
      epoch_registry_sqlite_path: "./runtime-epochs.db",
      timezone: "UTC",
      rollover: {
        daily_enabled: true,
        only_after_settled: true,
        max_entries: 1200,
        max_estimated_tokens: 80000,
        max_sqlite_bytes_per_session: 67108864,
        max_build_context_p95_ms: 300,
        max_process_rss_bytes: 1073741824,
        limits_status: "provisional_until_locked_pi_benchmark",
        allow_multiple_epochs_per_day: true,
        wrapup_wait_timeout_seconds: 10,
      },
      session_id_prefix: "iris-runtime",
      pi_input_persistence_mode: "pi_user_with_iris_meta_companion",
      provenance_storage: "pi_details",
      allow_fallback_sidecar: false,
      pi_compaction_mode: "forbidden_in_m1",
    },
    model: {
      main_agent: {
        active_profile: "opencode-go-deepseek-v4-flash-dev-nonthinking-v1",
        profiles: {
          "opencode-go-deepseek-v4-flash-dev-nonthinking-v1": {
            provider: "opencode-go",
            protocol: "openai-chat-completions",
            base_url: "https://opencode.ai/zen/go/v1/chat/completions",
            model: "deepseek-v4-flash",
            api_key_env: "OPENCODE_GO_API_KEY",
            thinking: { type: "disabled" },
            max_output_tokens: 8192,
            development_only: true,
          },
          "opencode-go-deepseek-v4-flash-dev-thinking-v1": {
            provider: "opencode-go",
            protocol: "openai-chat-completions",
            base_url: "https://opencode.ai/zen/go/v1/chat/completions",
            model: "deepseek-v4-flash",
            api_key_env: "OPENCODE_GO_API_KEY",
            thinking: { type: "enabled", reasoning_effort: "max" },
            max_output_tokens: 32768,
            development_only: true,
          },
        },
        test_budgets: {
          thinking_stress_max_output_tokens: 65536,
          thinking_stress_schedule: "manual_or_nightly_only",
          truncation_fixture_max_output_tokens: [1024, 2048],
        },
        verified_model_metadata: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          context_window: 1000000,
          max_output_tokens: 384000,
          source: "provider_official_documentation",
          verified_at: "2026-08-01",
        },
      },
    },
    host: {
      mode: "cli",
      http: { bind_host: "127.0.0.1", port: 18001, remote_access: false },
      origin: { principal_ref_log_mode: "hash" },
      input_queue_max: 20,
      shutdown_grace_ms: 30000,
      data_root_lock: { enabled: true, path: "./iris.lock", mode: "os_exclusive_fail_fast" },
      ingress: {
        sqlite_path: "./ingress.db",
        blob_root: "./blobs/ingress",
        dedupe_key: "instance_epoch_plus_input_id",
        payload_hash_required: true,
        states: ["accepted", "session_committed", "rejected"],
      },
    },
    observability: {
      log_level: "warn",
      json_logs: true,
      metrics_enabled: true,
      tracing_enabled: false,
      redact_sensitive_fields: true,
    },
    ...overrides,
  });
}
