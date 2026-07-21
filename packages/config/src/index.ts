export interface RuntimeConfig {
  databasePath: string;
  mediaLibraryPath: string;
  originalsLibraryPath: string;
  archiveDevicePath: string;
  workerPollIntervalMs: number;
  archiveWorkerConcurrency: number;
  encodeWorkerConcurrency: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_ARCHIVE_DEVICE_PATH = "/dev/sr0";
const DEFAULT_WORKER_POLL_INTERVAL_MS = 5_000;
const DEFAULT_ARCHIVE_WORKER_CONCURRENCY = 1;
const DEFAULT_ENCODE_WORKER_CONCURRENCY = 1;

function requiredValue(environment: Environment, name: string): string {
  const value = environment[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function positiveInteger(
  environment: Environment,
  name: string,
  defaultValue: number,
): number {
  const rawValue = environment[name]?.trim();

  if (!rawValue) {
    return defaultValue;
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

export function loadConfig(environment: Environment = process.env): RuntimeConfig {
  return {
    databasePath: requiredValue(environment, "RIP_DVD_DATABASE_PATH"),
    mediaLibraryPath: requiredValue(environment, "RIP_DVD_MEDIA_LIBRARY_PATH"),
    originalsLibraryPath: requiredValue(
      environment,
      "RIP_DVD_ORIGINALS_LIBRARY_PATH",
    ),
    archiveDevicePath:
      environment.RIP_DVD_ARCHIVE_DEVICE_PATH?.trim() ||
      DEFAULT_ARCHIVE_DEVICE_PATH,
    workerPollIntervalMs: positiveInteger(
      environment,
      "RIP_DVD_WORKER_POLL_INTERVAL_MS",
      DEFAULT_WORKER_POLL_INTERVAL_MS,
    ),
    archiveWorkerConcurrency: positiveInteger(
      environment,
      "RIP_DVD_ARCHIVE_WORKER_CONCURRENCY",
      DEFAULT_ARCHIVE_WORKER_CONCURRENCY,
    ),
    encodeWorkerConcurrency: positiveInteger(
      environment,
      "RIP_DVD_ENCODE_WORKER_CONCURRENCY",
      DEFAULT_ENCODE_WORKER_CONCURRENCY,
    ),
  };
}
