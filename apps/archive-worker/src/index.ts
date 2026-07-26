import { loadConfig } from "@rip-dvd/config";
import { createDataAccess } from "@rip-dvd/data-access";

import { runArchiveWorker } from "./archive-worker.js";
import { createLinuxOpticalDriveHardware } from "./optical-drive-hardware.js";

const config = loadConfig();
const access = createDataAccess({ databasePath: config.databasePath });
const controller = new AbortController();

function stop(signal: "SIGINT" | "SIGTERM"): void {
  if (controller.signal.aborted) {
    return;
  }
  console.log(`Archive worker received ${signal}; stopping`);
  controller.abort(new Error(`Archive worker received ${signal}`));
}

const stopForSigint = () => stop("SIGINT");
const stopForSigterm = () => stop("SIGTERM");
process.once("SIGINT", stopForSigint);
process.once("SIGTERM", stopForSigterm);

console.log(
  `Archive worker ready (device: ${config.archiveDevicePath}, concurrency: ${config.archiveWorkerConcurrency})`,
);

try {
  await runArchiveWorker({
    access,
    configuredDevicePath: config.archiveDevicePath,
    hardware: createLinuxOpticalDriveHardware(),
    log: (message) => console.log(message),
    pollIntervalMs: config.workerPollIntervalMs,
    signal: controller.signal,
  });
} finally {
  process.removeListener("SIGINT", stopForSigint);
  process.removeListener("SIGTERM", stopForSigterm);
  access.close();
}
