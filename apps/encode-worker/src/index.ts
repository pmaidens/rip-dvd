import { loadConfig } from "@rip-dvd/config";
import {
  nodeWorkerLifecycleHost,
  startWorkerLifecycle,
} from "@rip-dvd/worker-runtime";

const config = loadConfig();

startWorkerLifecycle(
  {
    pollIntervalMs: config.workerPollIntervalMs,
    readyMessage: `Encode worker ready (concurrency: ${config.encodeWorkerConcurrency})`,
    workerName: "Encode",
  },
  nodeWorkerLifecycleHost,
);
