import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ConsistentReadAccess,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  createLegacySidecarDataAccess,
  type LegacySidecarDataAccess,
} from "@rip-dvd/data-access/legacy-sidecars";
import { afterEach } from "vitest";

type SnapshotOverrides = {
  catalog?: Partial<ConsistentReadAccess["catalog"]>;
  encodingProfiles?: Partial<ConsistentReadAccess["encodingProfiles"]>;
  archiveJobs?: Partial<ConsistentReadAccess["archiveJobs"]>;
  encodeJobs?: Partial<ConsistentReadAccess["encodeJobs"]>;
};

export function completeCatalogReview(
  access: DataAccess,
  archiveId: OriginalDiscArchiveId,
) {
  const archive = access.catalog.listOriginalDiscArchives({
    ids: [archiveId],
  })[0]!;
  return access.catalog.completeCatalogReview(archiveId, archive.updatedAt);
}

export function withSnapshotOverrides(
  access: DataAccess,
  overrides: SnapshotOverrides,
): DataAccess {
  return {
    ...access,
    readConsistentSnapshot(read) {
      return access.readConsistentSnapshot((snapshotAccess) =>
        read({
          catalog: {
            ...snapshotAccess.catalog,
            ...overrides.catalog,
          },
          encodingProfiles: {
            ...snapshotAccess.encodingProfiles,
            ...overrides.encodingProfiles,
          },
          archiveJobs: {
            ...snapshotAccess.archiveJobs,
            ...overrides.archiveJobs,
          },
          encodeJobs: {
            ...snapshotAccess.encodeJobs,
            ...overrides.encodeJobs,
          },
        }),
      );
    },
  };
}

export function useDataAccessFixture(): {
  create(): LegacySidecarDataAccess;
  createWithDatabasePath(): {
    access: LegacySidecarDataAccess;
    databasePath: string;
  };
  createPair(): [LegacySidecarDataAccess, LegacySidecarDataAccess];
} {
  const temporaryDirectories: string[] = [];
  const openDataAccess: LegacySidecarDataAccess[] = [];

  afterEach(() => {
    for (const access of openDataAccess.splice(0)) {
      access.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  return {
    create() {
      const directory = mkdtempSync(join(tmpdir(), "rip-dvd-dashboard-"));
      temporaryDirectories.push(directory);
      const access = createLegacySidecarDataAccess({
        databasePath: join(directory, "test.sqlite"),
      });
      openDataAccess.push(access);
      return access;
    },
    createWithDatabasePath() {
      const directory = mkdtempSync(join(tmpdir(), "rip-dvd-dashboard-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "test.sqlite");
      const access = createLegacySidecarDataAccess({ databasePath });
      openDataAccess.push(access);
      return { access, databasePath };
    },
    createPair() {
      const directory = mkdtempSync(join(tmpdir(), "rip-dvd-dashboard-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "test.sqlite");
      const pair: [LegacySidecarDataAccess, LegacySidecarDataAccess] = [
        createLegacySidecarDataAccess({ databasePath }),
        createLegacySidecarDataAccess({ databasePath }),
      ];
      openDataAccess.push(...pair);
      return pair;
    },
  };
}
