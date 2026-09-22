import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDataAccess } from "@rip-dvd/data-access";
import type { CatalogMetadataLookup } from "@rip-dvd/application";

import { runCommand } from "./command.js";

export function createOperatorWorkflowFixture() {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-operator-cli-"));
  const databasePath = join(directory, "catalog.sqlite");
  const mediaLibraryPath = join(directory, "movies");
  const originalsLibraryPath = join(directory, "originals");
  mkdirSync(mediaLibraryPath);
  mkdirSync(originalsLibraryPath);

  const openAccess = () => createDataAccess({
    databasePath,
    mediaLibraryPath,
    originalsLibraryPath,
  });

  return {
    databasePath,
    mediaLibraryPath,
    originalsLibraryPath,
    openAccess,
    async run(args: readonly string[], lookup?: CatalogMetadataLookup | null) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCommand(args, {
        openAccess,
        ...(lookup === undefined ? {} : { getLookup: () => lookup }),
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      return {
        exitCode,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        result: JSON.parse(stdout.join("")) as unknown,
      };
    },
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
