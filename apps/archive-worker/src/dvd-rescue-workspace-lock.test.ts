import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createInProcessDvdRescueWorkspaceLock,
  createNodeDvdRescueWorkspaceLock,
  type DvdRescueWorkspaceLock,
} from "./dvd-rescue-workspace-lock.js";

const temporaryDirectories: string[] = [];
const hasFlock =
  spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;

function createOriginalsLibrary(): string {
  const directory = mkdtempSync(join(tmpdir(), "rip-dvd-rescue-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function expectExclusiveLock(lock: DvdRescueWorkspaceLock) {
  const originalsLibraryPath = createOriginalsLibrary();
  const options = {
    archiveRequestId: "archive-request:disc:lock-test",
    originalsLibraryPath,
    signal: new AbortController().signal,
  };
  let confirmEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    confirmEntered = resolve;
  });
  let releaseFirst!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = lock.withLock({
    ...options,
    task: async () => {
      confirmEntered();
      await release;
      return "first";
    },
  });
  await entered;

  await expect(
    lock.withLock({
      ...options,
      task: async () => "overlap",
    }),
  ).rejects.toThrow("DVD rescue workspace is already active");

  releaseFirst();
  await expect(first).resolves.toBe("first");
  await expect(
    lock.withLock({
      ...options,
      task: async () => "successor",
    }),
  ).resolves.toBe("successor");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("DVD rescue workspace lock", () => {
  it("excludes overlapping work in one process", async () => {
    await expectExclusiveLock(createInProcessDvdRescueWorkspaceLock());
  });

  it.skipIf(!hasFlock)(
    "excludes overlapping work across file descriptors",
    async () => {
      await expectExclusiveLock(createNodeDvdRescueWorkspaceLock());
    },
  );
});
