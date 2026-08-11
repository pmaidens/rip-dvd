export interface RuntimeConfig {
  databasePath: string;
  mediaLibraryPath: string;
  originalsLibraryPath: string;
  archiveDevicePath: string;
  webTrustedOrigin: string;
  workerPollIntervalMs: number;
  archiveWorkerConcurrency: number;
  encodeWorkerConcurrency: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_ARCHIVE_DEVICE_PATH = "/dev/sr0";
const DEFAULT_WEB_TRUSTED_ORIGIN = "http://localhost:3000";
const DEFAULT_WORKER_POLL_INTERVAL_MS = 5_000;
const DEFAULT_ARCHIVE_WORKER_CONCURRENCY = 1;
const DEFAULT_ENCODE_WORKER_CONCURRENCY = 1;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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

function timerDelayMilliseconds(
  environment: Environment,
  name: string,
  defaultValue: number,
): number {
  const value = positiveInteger(environment, name, defaultValue);

  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must be at most ${MAX_TIMER_DELAY_MS}`);
  }

  return value;
}

export function normalizeHttpOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  return url.origin;
}

function httpOrigin(
  environment: Environment,
  name: string,
  defaultValue: string,
): string {
  const rawValue = environment[name]?.trim() || defaultValue;
  const origin = normalizeHttpOrigin(rawValue);
  if (origin === null) {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  return origin;
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
    webTrustedOrigin: httpOrigin(
      environment,
      "RIP_DVD_WEB_TRUSTED_ORIGIN",
      DEFAULT_WEB_TRUSTED_ORIGIN,
    ),
    workerPollIntervalMs: timerDelayMilliseconds(
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
