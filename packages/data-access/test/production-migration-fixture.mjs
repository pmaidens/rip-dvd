import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const settlingMigration =
  "20260822142722_disc-inspection-settling";
export const boundedSettlingMigration =
  "20260822183552_bounded-disc-settling";

const productionRows = new URL(
  "./fixtures/pre-bounded-disc-settling-production.sql",
  import.meta.url,
);

function migrationCreatedAt(name) {
  const timestamp = name.slice(0, 14);
  return Date.UTC(
    Number(timestamp.slice(0, 4)),
    Number(timestamp.slice(4, 6)) - 1,
    Number(timestamp.slice(6, 8)),
    Number(timestamp.slice(8, 10)),
    Number(timestamp.slice(10, 12)),
    Number(timestamp.slice(12, 14)),
  );
}

function executeMigration(sqlite, migrationSql) {
  for (const statement of migrationSql.split("--> statement-breakpoint")) {
    if (statement.trim()) {
      sqlite.exec(statement);
    }
  }
}

export function createPreBoundedDiscSettlingProductionFixture({
  databasePath,
  migrationsRoot = new URL("../drizzle/", import.meta.url),
}) {
  const sqlite = new DatabaseSync(databasePath);
  const predecessorNames = readdirSync(migrationsRoot)
    .filter((name) => /^\d/.test(name) && name < boundedSettlingMigration)
    .sort();

  for (const migrationName of predecessorNames) {
    // Production's journal contains this name while its table retains the
    // preceding deployment's column set.
    if (migrationName === settlingMigration) {
      continue;
    }
    executeMigration(
      sqlite,
      readFileSync(
        new URL(`${migrationName}/migration.sql`, migrationsRoot),
        "utf8",
      ),
    );
  }

  sqlite.exec(`
    CREATE TABLE __drizzle_migrations (
      id INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at NUMERIC,
      name TEXT,
      applied_at TEXT
    )
  `);
  const recordMigration = sqlite.prepare(`
    INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
    VALUES (?, ?, ?, '2026-08-22T18:00:00.000Z')
  `);
  for (const migrationName of predecessorNames) {
    const migrationSql = readFileSync(
      new URL(`${migrationName}/migration.sql`, migrationsRoot),
      "utf8",
    );
    recordMigration.run(
      createHash("sha256").update(migrationSql).digest("hex"),
      migrationCreatedAt(migrationName),
      migrationName,
    );
  }

  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(readFileSync(productionRows, "utf8"));
  sqlite.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databasePath = process.argv[2];
  if (!databasePath) {
    throw new Error("Database path argument is required");
  }
  createPreBoundedDiscSettlingProductionFixture({ databasePath });
  console.log(`Created production-shaped migration fixture at ${databasePath}`);
}
