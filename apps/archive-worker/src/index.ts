import { loadConfig } from "@rip-dvd/config";

const config = loadConfig();

console.log(
  `Archive worker ready (device: ${config.archiveDevicePath}, concurrency: ${config.archiveWorkerConcurrency})`,
);

const heartbeat = setInterval(() => {
  // Job polling is added in a later worker ticket. Keeping this runtime alive
  // proves that Compose manages it independently from the web process.
}, config.workerPollIntervalMs);

function shutdown(signal: string): void {
  clearInterval(heartbeat);
  console.log(`Archive worker received ${signal}; stopping`);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
