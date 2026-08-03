import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface MigrationResult {
  databasePath: string;
  appliedVersions: string[];
}

export function migrateDatabase(databasePath: string, migrationsDir: string): MigrationResult {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (" +
        "version TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL DEFAULT '')",
    );

    const columns = db
      .prepare("PRAGMA table_info(schema_migrations)")
      .all()
      .map((row) => (row as { name: string }).name);
    if (!columns.includes("checksum")) {
      db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");
    }

    const applied = new Map<string, string>(
      db
        .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => {
          const entry = row as { version: string; checksum: string };
          return [entry.version, entry.checksum];
        }),
    );

    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const appliedVersions: string[] = [];

    // Newer-schema fail-closed (R3 Feature B1): an applied migration version
    // that does NOT exist in the migrations directory means the database was
    // created by a NEWER build than this binary. Opening it read/write with
    // an older schema runner could corrupt or misread the data — refuse.
    const knownVersions = new Set(files.map((file) => file.replace(/\.sql$/, "")));
    for (const appliedVersion of applied.keys()) {
      if (!knownVersions.has(appliedVersion)) {
        throw new Error(
          `database schema is NEWER than this build: applied migration ${appliedVersion} ` +
            "is not present in the migrations directory (fail closed; upgrade the binary)",
        );
      }
    }

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existingChecksum = applied.get(version);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== "" && existingChecksum !== checksum) {
          throw new Error(`migration ${version} changed after being applied`);
        }
        continue;
      }
      db.exec("BEGIN");
      try {
        db.exec(sql);
        db.prepare(
          "INSERT INTO schema_migrations(version, applied_at, checksum) VALUES (?, ?, ?)",
        ).run(version, new Date().toISOString(), checksum);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      appliedVersions.push(version);
    }

    return { databasePath, appliedVersions };
  } finally {
    db.close();
  }
}

export function initializeDatabase(databasePath: string, migrationsDir: string): MigrationResult {
  return migrateDatabase(databasePath, migrationsDir);
}
