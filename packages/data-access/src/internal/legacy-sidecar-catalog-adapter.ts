import type { drizzle } from "drizzle-orm/node-sqlite";

import type { LegacySidecarAccess } from "../legacy-sidecar-types.js";

export type LegacySidecarCatalogAdapter = Pick<
  ReturnType<typeof drizzle>,
  "select" | "transaction"
>;

export interface LegacySidecarImportAccessFactory {
  createAccess(
    catalog: LegacySidecarCatalogAdapter,
    now: () => Date,
  ): LegacySidecarAccess;
}
