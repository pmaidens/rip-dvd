import { runLegacySidecarImportCli } from "../packages/data-access/dist/legacy-sidecar-cli.js";

process.exitCode = runLegacySidecarImportCli({
  argv: process.argv.slice(2),
  environment: process.env,
  writeError: (message) => process.stderr.write(message),
  writeOutput: (message) => process.stdout.write(message),
});
