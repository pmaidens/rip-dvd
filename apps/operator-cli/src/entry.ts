#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createDataAccess } from "@rip-dvd/data-access";
import { loadConfig } from "@rip-dvd/config";

import { CommandFailure, runCommand } from "./command.js";

process.exitCode = await runCommand(process.argv.slice(2), {
  readStdin: () => readFileSync(0, "utf8"),
  readFile: (path) => readFileSync(path, "utf8"),
  mediaLibraryPath: () => loadConfig().mediaLibraryPath,
  openAccess: () => {
    let config;
    try {
      config = loadConfig();
    } catch {
      throw new CommandFailure(
        "CONFIGURATION_ERROR",
        "Application configuration is missing or invalid.",
        1,
      );
    }
    return createDataAccess({
      databasePath: config.databasePath,
      mediaLibraryPath: config.mediaLibraryPath,
      originalsLibraryPath: config.originalsLibraryPath,
    });
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
