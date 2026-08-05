import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import type { AgentConfigV3 } from "../config/schema.js";
import { migrateDatabase } from "../db/migrate.js";

export interface DataRootPaths {
  dataRoot: string;
  sessionDb: string;
  epochRegistryDb: string;
  contextDb: string;
  historianDb: string;
  toolExecutionDb: string;
  ingressDb: string;
  runtimeLedgerDb: string;
  blobsHistory: string;
  blobsToolsRecovery: string;
  blobsIngress: string;
  workspace: string;
  cache: string;
  run: string;
  lockFile: string;
}

export function resolveDataRootPaths(dataRoot: string, config: AgentConfigV3): DataRootPaths {
  const root = resolve(dataRoot);
  const rel = (value: string | undefined, fallback: string): string =>
    resolve(root, value ?? fallback);
  return {
    dataRoot: root,
    sessionDb: rel(config.runtime_sessions.sqlite_path, "session.db"),
    epochRegistryDb: rel(config.runtime_sessions.epoch_registry_sqlite_path, "runtime-epochs.db"),
    contextDb: rel(config.context?.sqlite_path, "context.db"),
    historianDb: rel(config.historian?.sqlite_path, "historian.db"),
    toolExecutionDb: rel(config.tools?.sqlite_path, "tool-execution.db"),
    ingressDb: rel(config.host.ingress.sqlite_path, "ingress.db"),
    runtimeLedgerDb: rel(undefined, "runtime-ledger.db"),
    blobsHistory: rel(config.runtime_sessions.blob_root, "blobs/history"),
    blobsToolsRecovery: rel(config.tools?.recovery_blob_root, "blobs/tools/recovery"),
    blobsIngress: rel(config.host.ingress.blob_root, "blobs/ingress"),
    workspace: join(root, "workspace"),
    cache: join(root, "cache"),
    run: join(root, "run"),
    lockFile: resolve(root, config.host.data_root_lock.path),
  };
}

export function initializeDataRoot(dataRoot: string, config: AgentConfigV3): DataRootPaths {
  const paths = resolveDataRootPaths(dataRoot, config);
  for (const dir of [
    paths.blobsHistory,
    paths.blobsToolsRecovery,
    paths.blobsIngress,
    paths.workspace,
    paths.cache,
    paths.run,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const migrationRoot = fileURLToPath(new URL("../db/migrations", import.meta.url));
  migrateDatabase(paths.epochRegistryDb, join(migrationRoot, "runtime-epochs"));
  migrateDatabase(paths.ingressDb, join(migrationRoot, "ingress"));
  migrateDatabase(paths.contextDb, join(migrationRoot, "context"));
  migrateDatabase(paths.runtimeLedgerDb, join(migrationRoot, "runtime-events"));
  // R3-P0：historian.db 迁移注册（0001_bootstrap / 0002_delivered_receipt /
  // 0003_continuity_snapshots），与其它 DB 相同的 checksum/idempotency 语义。
  migrateDatabase(paths.historianDb, join(migrationRoot, "historian"));
  return paths;
}

export function writeDefaultAgentConfig(dataRoot: string, config: AgentConfigV3): string {
  const target = join(dataRoot, "agent.json");
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return target;
}
