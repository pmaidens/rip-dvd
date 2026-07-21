import { loadConfig } from "@rip-dvd/config";
import {
  nodeWorkerLifecycleHost,
  startWorkerLifecycle,
} from "@rip-dvd/worker-runtime";

const config = loadConfig();

startWorkerLifecycle(
  {
    pollIntervalMs: config.workerPollIntervalMs,
    readyMessage: `Archive worker ready (device: ${config.archiveDevicePath}, concurrency: ${config.archiveWorkerConcurrency})`,
    workerName: "Archive",
  },
  nodeWorkerLifecycleHost,
);
