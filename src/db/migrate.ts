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
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );

    const applied = new Set(
      db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => (row as { version: string }).version),
    );

    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const appliedVersions: string[] = [];

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) {
        continue;
      }
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      db.exec("BEGIN");
      try {
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
          version,
          new Date().toISOString(),
        );
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
