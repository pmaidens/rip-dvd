import { DatabaseSync } from "node:sqlite";

const [databasePath] = process.argv.slice(2);
if (!databasePath) {
  throw new Error("SQLite writer helper requires a database path");
}

const database = new DatabaseSync(databasePath);
database.exec("PRAGMA busy_timeout = 250");
database.exec("BEGIN IMMEDIATE");
database.exec("ROLLBACK");
database.close();
