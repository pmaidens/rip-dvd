import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBoundedArchiveAuditRecordReader } from "./archive-audit-record-reader.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function worker(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-audit-record-worker-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "worker.mjs");
  writeFileSync(path, source);
  return path;
}

describe("bounded archive audit record reader", () => {
  it("terminates a synchronous database worker when the audit is aborted", async () => {
    const reader = createBoundedArchiveAuditRecordReader({
      workerPath: worker("setInterval(() => {}, 1000);"),
    });
    const controller = new AbortController();
    const reading = reader.read("/data/catalog.sqlite", 10, controller.signal);

    controller.abort(new Error("runtime expired"));

    await expect(reading).rejects.toThrow("runtime expired");
  });

  it("rejects malformed worker output with a fixed error", async () => {
    const reader = createBoundedArchiveAuditRecordReader({
      workerPath: worker(`
        import { parentPort } from "node:worker_threads";
        parentPort.postMessage({ page: { records: "private data" } });
      `),
    });

    await expect(reader.read(
      "/data/catalog.sqlite",
      10,
      new AbortController().signal,
    )).rejects.toThrow("Archive audit record read failed");
  });
});
