import { startConfiguredWorker } from "@rip-dvd/worker-runtime";

startConfiguredWorker({
  readyMessage: (config) =>
    `Archive worker ready (device: ${config.archiveDevicePath}, concurrency: ${config.archiveWorkerConcurrency})`,
  workerName: "Archive",
});
