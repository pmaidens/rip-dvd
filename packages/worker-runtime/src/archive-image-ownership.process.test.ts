import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { createArchiveImageOwnership } from "./archive-image-ownership.js";

const roots: string[] = [];
const helperPids: number[] = [];

afterEach(() => {
  for (const pid of helperPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The helper may already have exited.
    }
  }
  for (const path of roots.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("Helper did not become ready");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

it.runIf(process.platform === "linux")(
  "retains writer exclusion in the actual helper after the parent dies and reports an expired claim",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const readyPath = join(originalsLibraryPath, "helper.ready");
    const parent = spawn(
      process.execPath,
      [
        fileURLToPath(new URL(
          "./test/archive-image-ownership-parent.mjs",
          import.meta.url,
        )),
        originalsLibraryPath,
        readyPath,
      ],
      { stdio: "ignore" },
    );
    await waitForFile(readyPath);
    helperPids.push(Number(readFileSync(readyPath, "utf8")));
    parent.kill("SIGKILL");
    await new Promise<void>((resolve) => parent.once("close", () => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    const ownership = createArchiveImageOwnership();
    expect(ownership.inspect({
      archiveId: "surviving-helper-archive",
      originalsLibraryPath,
    })).toMatchObject({
      writer: { state: "active" },
      workerClaim: { state: "expired" },
      stableRead: {
        available: false,
        blockingReasons: [{ code: "WRITER_NOT_QUIESCENT" }],
      },
    });

    await expect(ownership.withWriter({
      archiveId: "surviving-helper-archive",
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    })).rejects.toMatchObject({ code: "WRITER_NOT_QUIESCENT" });
  },
);
