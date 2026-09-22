import { setTimeout as delay } from "node:timers/promises";

export async function runDurableWorkPoller(input: {
  intervalMs: number;
  signal: AbortSignal;
  log(message: string): void;
  poll(): Promise<boolean>;
  pollFailureMessage: string;
  waitFailureMessage: string;
}): Promise<void> {
  while (!input.signal.aborted) {
    try {
      const handled = await input.poll();
      if (handled) continue;
    } catch {
      input.log(input.pollFailureMessage);
    }
    try {
      await delay(input.intervalMs, undefined, { signal: input.signal });
    } catch {
      if (!input.signal.aborted) throw new Error(input.waitFailureMessage);
    }
  }
}
