import { Worker } from "node:worker_threads";

import type { ArchiveAuditRecordPage } from "@rip-dvd/data-access/archive-audit-records";

export interface ArchiveAuditRecordReader {
  read(
    databasePath: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<ArchiveAuditRecordPage>;
}

export interface BoundedArchiveAuditRecordReaderOptions {
  workerPath?: string | URL;
}

function isRecordPage(
  value: unknown,
  limit: number,
): value is ArchiveAuditRecordPage {
  return value !== null &&
    typeof value === "object" &&
    "truncated" in value &&
    typeof value.truncated === "boolean" &&
    "records" in value &&
    Array.isArray(value.records) &&
    value.records.length <= limit &&
    value.records.every((record: unknown) =>
      record !== null &&
      typeof record === "object" &&
      "archivedAt" in record &&
      record.archivedAt instanceof Date
    );
}

function fixedReadError(): Error {
  return new Error("Archive audit record read failed");
}

export function createBoundedArchiveAuditRecordReader({
  workerPath = new URL("./archive-audit-record-worker.js", import.meta.url),
}: BoundedArchiveAuditRecordReaderOptions = {}): ArchiveAuditRecordReader {
  return {
    read(databasePath, limit, signal) {
      signal.throwIfAborted();
      return new Promise<ArchiveAuditRecordPage>((resolve, reject) => {
        let settled = false;
        const worker = new Worker(workerPath, {
          workerData: { databasePath, limit },
        });
        const finish = (
          action: () => void,
        ): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          void worker.terminate();
          action();
        };
        const abort = () => finish(() => reject(signal.reason));
        signal.addEventListener("abort", abort, { once: true });
        worker.once("message", (message: unknown) => {
          const page = message !== null &&
              typeof message === "object" &&
              "page" in message
            ? message.page
            : null;
          finish(() => {
            if (isRecordPage(page, limit)) {
              resolve(page);
            } else {
              reject(fixedReadError());
            }
          });
        });
        worker.once("error", () => finish(() => reject(fixedReadError())));
        worker.once("exit", (code) => {
          if (code !== 0) finish(() => reject(fixedReadError()));
        });
      });
    },
  };
}
