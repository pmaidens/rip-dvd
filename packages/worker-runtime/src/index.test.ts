import { describe, expect, it } from "vitest";

import {
  startConfiguredWorker,
  startWorkerLifecycle,
  type WorkerLifecycleHost,
  type WorkerSignal,
} from "./index.js";

const environment = {
  RIP_DVD_DATABASE_PATH: "/data/rip-dvd.sqlite",
  RIP_DVD_MEDIA_LIBRARY_PATH: "/media/movies",
  RIP_DVD_ORIGINALS_LIBRARY_PATH: "/media/originals",
  RIP_DVD_ARCHIVE_DEVICE_PATH: "/dev/test-dvd",
  RIP_DVD_WORKER_POLL_INTERVAL_MS: "2500",
  RIP_DVD_ARCHIVE_WORKER_CONCURRENCY: "2",
  RIP_DVD_ENCODE_WORKER_CONCURRENCY: "3",
};

describe("startWorkerLifecycle", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "starts one heartbeat and shuts it down on %s",
    (signal) => {
      const logs: string[] = [];
      const registeredSignals = new Map<WorkerSignal, () => void>();
      const clearedTimers: string[] = [];
      const host: WorkerLifecycleHost<string> = {
        clearInterval: (handle) => clearedTimers.push(handle),
        log: (message) => logs.push(message),
        once: (registeredSignal, listener) =>
          registeredSignals.set(registeredSignal, listener),
        setInterval: (_callback, intervalMs) => {
          expect(intervalMs).toBe(5_000);
          return "heartbeat";
        },
      };

      startWorkerLifecycle(
        {
          pollIntervalMs: 5_000,
          readyMessage: "Archive worker ready",
          workerName: "Archive",
        },
        host,
      );

      expect(logs).toEqual(["Archive worker ready"]);
      expect([...registeredSignals.keys()]).toEqual(["SIGINT", "SIGTERM"]);

      registeredSignals.get(signal)?.();

      expect(clearedTimers).toEqual(["heartbeat"]);
      expect(logs).toEqual([
        "Archive worker ready",
        `Archive worker received ${signal}; stopping`,
      ]);
    },
  );
});

describe("startConfiguredWorker", () => {
  it("loads shared config and starts the lifecycle from one role descriptor", () => {
    const logs: string[] = [];
    const registeredSignals = new Map<WorkerSignal, () => void>();
    const host: WorkerLifecycleHost<string> = {
      clearInterval: () => undefined,
      log: (message) => logs.push(message),
      once: (signal, listener) => registeredSignals.set(signal, listener),
      setInterval: (_callback, intervalMs) => {
        expect(intervalMs).toBe(2_500);
        return "heartbeat";
      },
    };

    startConfiguredWorker(
      {
        readyMessage: (config) =>
          `Archive worker ready (device: ${config.archiveDevicePath}, concurrency: ${config.archiveWorkerConcurrency})`,
        workerName: "Archive",
      },
      { environment, lifecycleHost: host },
    );

    expect(logs).toEqual([
      "Archive worker ready (device: /dev/test-dvd, concurrency: 2)",
    ]);
    expect([...registeredSignals.keys()]).toEqual(["SIGINT", "SIGTERM"]);
  });
});
