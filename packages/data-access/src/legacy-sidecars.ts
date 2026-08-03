import {
  createDataAccessInternal,
  type CreateDataAccessOptions,
} from "./internal/create-data-access.js";
import {
  acquireLegacyQueueCutoverLock,
  resolveLegacyOriginalsLibrary,
} from "./internal/legacy-sidecars.js";
import { createLegacySidecarImportAccess } from "./internal/legacy-sidecar-migration.js";
import type { LegacySidecarDataAccess } from "./legacy-sidecar-types.js";

export type {
  LegacySidecarAccess,
  LegacySidecarArchiveJobAccess,
  LegacySidecarCatalogAccess,
  LegacySidecarDataAccess,
  LegacySidecarImportIssue,
  LegacySidecarImportIssueCode,
  LegacySidecarImportReport,
} from "./legacy-sidecar-types.js";

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLegacySidecarDataAccess(
  input: CreateDataAccessOptions,
): LegacySidecarDataAccess {
  const access = createDataAccessInternal(input, {
    createAccess: createLegacySidecarImportAccess,
  });
  return {
    ...access,
    legacySidecars: {
      importLibrary(importInput) {
        if (!importInput.originalsLibraryPath.trim()) {
          return access.legacySidecars.importLibrary(importInput);
        }
        const originalsLibraryPath = resolveLegacyOriginalsLibrary(
          importInput.originalsLibraryPath,
        );
        const releaseQueueLock =
          acquireLegacyQueueCutoverLock(originalsLibraryPath);
        const importOutcome = (() => {
          try {
            return {
              outcome: "returned" as const,
              report: access.legacySidecars.importLibrary({
                originalsLibraryPath,
                recoverHistoricalCutover:
                  importInput.recoverHistoricalCutover,
              }),
            };
          } catch (error) {
            return { outcome: "threw" as const, error };
          }
        })();
        try {
          releaseQueueLock();
        } catch (releaseError) {
          if (importOutcome.outcome === "threw") {
            throw new AggregateError(
              [importOutcome.error, releaseError],
              `Legacy sidecar import failed: ${failureMessage(importOutcome.error)}; queue-lock release also failed: ${failureMessage(releaseError)}`,
            );
          }
          throw releaseError;
        }
        if (importOutcome.outcome === "threw") {
          throw importOutcome.error;
        }
        return importOutcome.report;
      },
    },
  };
}
