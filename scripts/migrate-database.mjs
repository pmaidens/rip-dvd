import { createDataAccess } from "../packages/data-access/dist/index.js";

const databasePath = process.env.RIP_DVD_DATABASE_PATH?.trim();
if (!databasePath) {
  throw new Error("RIP_DVD_DATABASE_PATH is required");
}

const access = createDataAccess({ databasePath });
access.close();
console.log(`SQLite migrations are current at ${databasePath}`);
