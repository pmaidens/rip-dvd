import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDataAccess,
  type ConsistentReadAccess,
  type DataAccess,
} from "@rip-dvd/data-access";
import { afterEach } from "vitest";

type SnapshotOverrides = {
  catalog?: Partial<ConsistentReadAccess["catalog"]>;
  encodingProfiles?: Partial<ConsistentReadAccess["encodingProfiles"]>;
  archiveJobs?: Partial<ConsistentReadAccess["archiveJobs"]>;
  encodeJobs?: Partial<ConsistentReadAccess["encodeJobs"]>;
};

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
  create(): DataAccess;
  createPair(): [DataAccess, DataAccess];
} {
  const temporaryDirectories: string[] = [];
  const openDataAccess: DataAccess[] = [];

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
      const access = createDataAccess({
        databasePath: join(directory, "test.sqlite"),
      });
      openDataAccess.push(access);
      return access;
    },
    createPair() {
      const directory = mkdtempSync(join(tmpdir(), "rip-dvd-dashboard-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "test.sqlite");
      const pair: [DataAccess, DataAccess] = [
        createDataAccess({ databasePath }),
        createDataAccess({ databasePath }),
      ];
      openDataAccess.push(...pair);
      return pair;
    },
  };
}
