import { createLegacySidecarDataAccess } from "./legacy-sidecars.js";
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
  --recover-historical-cutover
                            Explicitly recover a schema-2/3 cutover from bounded surviving legacy files
  --json                    Print the complete machine-readable report
  --help                    Show this help
`;

interface ParsedArguments {
  databasePath?: string;
  help: boolean;
  json: boolean;
  originalsLibraryPath?: string;
  recoverHistoricalCutover: boolean;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    help: false,
    json: false,
    recoverHistoricalCutover: false,
  };
  const argumentsToParse = argv[0] === "--" ? argv.slice(1) : argv;
  const seen = new Set<string>();
  for (let index = 0; index < argumentsToParse.length; index += 1) {
    const argument = argumentsToParse[index];
    if (
      argument !== "--database" &&
      argument !== "--originals-library" &&
      argument !== "--recover-historical-cutover" &&
      argument !== "--json" &&
      argument !== "--help"
    ) {
      throw new Error(
        argument.startsWith("-")
          ? `Unknown option: ${argument}`
          : `Unexpected argument: ${argument}`,
      );
    }
    if (seen.has(argument)) {
      throw new Error(`Duplicate option: ${argument}`);
    }
    seen.add(argument);
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    if (argument === "--help") {
      parsed.help = true;
      continue;
    }
    if (argument === "--recover-historical-cutover") {
      parsed.recoverHistoricalCutover = true;
      continue;
    }
    const value = argumentsToParse[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a path`);
    }
    if (argument === "--database") {
      parsed.databasePath = value;
    } else {
      parsed.originalsLibraryPath = value;
    }
    index += 1;
  }
  return parsed;
}

export function runLegacySidecarImportCli({
  argv,
  environment,
  writeError,
  writeOutput,
}: LegacySidecarImportCliOptions): number {
  let parsedArguments: ParsedArguments;
  let databasePath: string;
  let originalsLibraryPath: string;
  try {
    parsedArguments = parseArguments(argv);
    databasePath =
      parsedArguments.databasePath ??
      environment.RIP_DVD_DATABASE_PATH?.trim() ??
      "";
    originalsLibraryPath =
      parsedArguments.originalsLibraryPath ??
      environment.RIP_DVD_ORIGINALS_LIBRARY_PATH?.trim() ??
      "";
  } catch (error) {
    writeError(
      `${error instanceof Error ? error.message : String(error)}\n${usage}`,
    );
    return 2;
  }
  if (parsedArguments.help) {
    writeOutput(usage);
    return 0;
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

  let access: ReturnType<typeof createLegacySidecarDataAccess> | undefined;
  try {
    access = createLegacySidecarDataAccess({ databasePath });
    const report = access.legacySidecars.importLibrary({
      originalsLibraryPath,
      recoverHistoricalCutover:
        parsedArguments.recoverHistoricalCutover,
    });
    if (parsedArguments.json) {
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
