import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTemporaryDirectoryFixture() {
  const directories: string[] = [];

  return {
    cleanup() {
      for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
      }
    },
    create(prefix: string) {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
      directories.push(directory);
      return directory;
    },
  };
}
