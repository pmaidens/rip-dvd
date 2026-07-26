import { createDataAccess } from "./index.js";
import { resolveLegacyOriginalsLibrary } from "./internal/legacy-sidecars.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface LegacySidecarImportCliOptions {
  argv: readonly string[];
  environment: Environment;
  writeError(message: string): void;
  writeOutput(message: string): void;
}

const usage = `Usage: pnpm import:legacy-sidecars -- [options]

Options:
  --database PATH           SQLite catalog path (or RIP_DVD_DATABASE_PATH)
  --originals-library PATH  Originals library root (or RIP_DVD_ORIGINALS_LIBRARY_PATH)
  --json                    Print the complete machine-readable report
  --help                    Show this help
`;

function argumentValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a path`);
  }
  return value;
}

export function runLegacySidecarImportCli({
  argv,
  environment,
  writeError,
  writeOutput,
}: LegacySidecarImportCliOptions): number {
  if (argv.includes("--help")) {
    writeOutput(usage);
    return 0;
  }

  let databasePath: string;
  let originalsLibraryPath: string;
  try {
    databasePath =
      argumentValue(argv, "--database") ??
      environment.RIP_DVD_DATABASE_PATH?.trim() ??
      "";
    originalsLibraryPath =
      argumentValue(argv, "--originals-library") ??
      environment.RIP_DVD_ORIGINALS_LIBRARY_PATH?.trim() ??
      "";
  } catch (error) {
    writeError(
      `${error instanceof Error ? error.message : String(error)}\n${usage}`,
    );
    return 2;
  }
  if (!databasePath || !originalsLibraryPath) {
    writeError(
      `Both the database and originals library paths are required.\n${usage}`,
    );
    return 2;
  }
  try {
    originalsLibraryPath = resolveLegacyOriginalsLibrary(originalsLibraryPath);
  } catch (error) {
    writeError(
      `Legacy sidecar import failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  let access: ReturnType<typeof createDataAccess> | undefined;
  try {
    access = createDataAccess({ databasePath });
    const report = access.legacySidecars.importLibrary({
      originalsLibraryPath,
    });
    if (argv.includes("--json")) {
      writeOutput(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      writeOutput(
        `Legacy sidecar import: ${report.sidecarsImported} imported, ${report.sidecarsSkipped} skipped, ${report.sidecarsFound} found.\n`,
      );
      for (const issue of report.issues) {
        const job = issue.jobIndex === undefined ? "" : ` job ${issue.jobIndex}`;
        writeError(
          `${issue.code}: ${issue.sidecarPath}${job}: ${issue.message}\n`,
        );
      }
    }
    return report.issues.length === 0 ? 0 : 1;
  } catch (error) {
    writeError(
      `Legacy sidecar import failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  } finally {
    access?.close();
  }
}
