import { loadConfig, type RuntimeConfig } from "@rip-dvd/config";

export type WorkerSignal = "SIGINT" | "SIGTERM";

export interface WorkerLifecycleHost<TimerHandle> {
  clearInterval(handle: TimerHandle): void;
  log(message: string): void;
  once(signal: WorkerSignal, listener: () => void): void;
  setInterval(callback: () => void, intervalMs: number): TimerHandle;
}

export interface AsyncWorkerLifecycleHost {
  log(message: string): void;
  once(signal: WorkerSignal, listener: () => void): void;
  removeListener(signal: WorkerSignal, listener: () => void): void;
}

export interface WorkerLifecycleOptions {
  pollIntervalMs: number;
  readyMessage: string;
  workerName: string;
}

export interface ConfiguredWorkerDescriptor {
  readyMessage(config: RuntimeConfig): string;
  workerName: string;
}

export interface ConfiguredWorkerDependencies<TimerHandle> {
  environment: Readonly<Record<string, string | undefined>>;
  lifecycleHost: WorkerLifecycleHost<TimerHandle>;
}

export interface ConfiguredAsyncWorkerDependencies {
  environment: Readonly<Record<string, string | undefined>>;
  lifecycleHost: AsyncWorkerLifecycleHost;
}

export interface AsyncWorkerContext {
  config: RuntimeConfig;
  log(message: string): void;
  signal: AbortSignal;
}

export const nodeWorkerLifecycleHost: WorkerLifecycleHost<
  ReturnType<typeof setInterval>
> = {
  clearInterval,
  log: (message) => console.log(message),
  once: (signal, listener) => process.once(signal, listener),
  setInterval,
};

export const nodeAsyncWorkerLifecycleHost: AsyncWorkerLifecycleHost = {
  log: (message) => console.log(message),
  once: (signal, listener) => process.once(signal, listener),
  removeListener: (signal, listener) =>
    process.removeListener(signal, listener),
};

export function startWorkerLifecycle<TimerHandle>(
  options: WorkerLifecycleOptions,
  host: WorkerLifecycleHost<TimerHandle>,
): void {
  host.log(options.readyMessage);

  const heartbeat = host.setInterval(() => {
    // Job polling is added in later worker tickets. Keeping this runtime alive
    // proves that Compose manages it independently from the web process.
  }, options.pollIntervalMs);

  const shutdown = (signal: WorkerSignal): void => {
    host.clearInterval(heartbeat);
    host.log(`${options.workerName} worker received ${signal}; stopping`);
  };

  host.once("SIGINT", () => shutdown("SIGINT"));
  host.once("SIGTERM", () => shutdown("SIGTERM"));
}

export function startConfiguredWorker<TimerHandle>(
  descriptor: ConfiguredWorkerDescriptor,
  dependencies?: ConfiguredWorkerDependencies<TimerHandle>,
): void {
  const config = loadConfig(dependencies?.environment);
  const lifecycleOptions: WorkerLifecycleOptions = {
    pollIntervalMs: config.workerPollIntervalMs,
    readyMessage: descriptor.readyMessage(config),
    workerName: descriptor.workerName,
  };

  if (dependencies) {
    startWorkerLifecycle(lifecycleOptions, dependencies.lifecycleHost);
    return;
  }

  startWorkerLifecycle(lifecycleOptions, nodeWorkerLifecycleHost);
}

export async function runConfiguredAsyncWorker(
  descriptor: ConfiguredWorkerDescriptor,
  run: (context: AsyncWorkerContext) => Promise<void>,
  dependencies?: ConfiguredAsyncWorkerDependencies,
): Promise<void> {
  const config = loadConfig(dependencies?.environment);
  const host = dependencies?.lifecycleHost ?? nodeAsyncWorkerLifecycleHost;
  const controller = new AbortController();
  const stop = (signal: WorkerSignal): void => {
    if (controller.signal.aborted) {
      return;
    }
    host.log(`${descriptor.workerName} worker received ${signal}; stopping`);
    controller.abort(
      new Error(`${descriptor.workerName} worker received ${signal}`),
    );
  };
  const stopForSigint = () => stop("SIGINT");
  const stopForSigterm = () => stop("SIGTERM");

  host.once("SIGINT", stopForSigint);
  host.once("SIGTERM", stopForSigterm);
  host.log(descriptor.readyMessage(config));
  try {
    await run({
      config,
      log: (message) => host.log(message),
      signal: controller.signal,
    });
  } finally {
    host.removeListener("SIGINT", stopForSigint);
    host.removeListener("SIGTERM", stopForSigterm);
  }
}
