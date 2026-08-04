import type { drizzle } from "drizzle-orm/node-sqlite";

import type { LegacySidecarAccess } from "../legacy-sidecar-types.js";
import type { OriginalDiscArchiveId } from "../types.js";

export type LegacySidecarCatalogAdapter = Pick<
  ReturnType<typeof drizzle>,
  "select" | "transaction"
>;
export type LegacySidecarCatalogReadAdapter = Pick<
  ReturnType<typeof drizzle>,
  "select"
>;

export interface LegacySidecarImportAccessFactory {
  createAccess(
    catalog: LegacySidecarCatalogAdapter,
    now: () => Date,
    requireReviewableDiscSelections: (
      archiveId: OriginalDiscArchiveId,
      catalog: LegacySidecarCatalogReadAdapter,
    ) => unknown,
  ): LegacySidecarAccess;
}
