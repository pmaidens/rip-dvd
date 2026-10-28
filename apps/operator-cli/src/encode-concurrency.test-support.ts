import { Worker } from "node:worker_threads";

export function encodeContender(script: URL, data: Record<string, unknown>) {
  const worker = new Worker(script, { workerData: data });
  const events = new Map<string, () => void>();
  const received = new Set<string>();
  const result = new Promise<{ outcome: string; code?: string; reasons?: string[]; claimToken?: string }>((resolve, reject) => {
    worker.on("error", reject);
    worker.on("message", (message) => {
      received.add(message.type); events.get(message.type)?.();
      if (message.type === "result") resolve(message.value);
    });
    worker.on("exit", (code) => { if (code !== 0) reject(new Error(`Encode contender exited ${code}`)); });
  });
  const event = (name: string) => received.has(name) ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    events.set(name, resolve); result.then(() => reject(new Error(`Encode contender ended before ${name}`)), reject);
  });
  return { result, event, terminate: () => worker.terminate() };
}
