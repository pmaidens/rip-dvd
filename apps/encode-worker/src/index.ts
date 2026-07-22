import { startConfiguredWorker } from "@rip-dvd/worker-runtime";

startConfiguredWorker({
  readyMessage: (config) =>
    `Encode worker ready (concurrency: ${config.encodeWorkerConcurrency})`,
  workerName: "Encode",
});
