import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDataAccess, type DataAccess } from "@rip-dvd/data-access";
import { afterEach } from "vitest";

export function useDataAccessFixture(): {
  create(): DataAccess;
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
  };
}
