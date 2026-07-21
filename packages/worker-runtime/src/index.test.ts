import { describe, expect, it } from "vitest";

import {
  startWorkerLifecycle,
  type WorkerLifecycleHost,
  type WorkerSignal,
} from "./index.js";

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
