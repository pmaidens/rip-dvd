import { loadConfig } from "@rip-dvd/config";

const config = loadConfig();

console.log(
  `Encode worker ready (concurrency: ${config.encodeWorkerConcurrency})`,
);

const heartbeat = setInterval(() => {
  // Job polling is added in a later worker ticket. Keeping this runtime alive
  // proves that Compose manages it independently from the web process.
}, config.workerPollIntervalMs);

function shutdown(signal: string): void {
  clearInterval(heartbeat);
  console.log(`Encode worker received ${signal}; stopping`);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
