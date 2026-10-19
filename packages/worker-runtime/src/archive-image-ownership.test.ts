import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME,
  ArchiveImageOwnershipError,
  createArchiveImageOwnership,
} from "./archive-image-ownership.js";

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "rip-dvd-image-ownership-"));
  roots.push(path);
  return path;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("archive image ownership", () => {
  it("excludes writers from a shared consistent-read interval", async () => {
    const ownership = createArchiveImageOwnership();
    const originalsLibraryPath = root();
    const entered = deferred<void>();
    const release = deferred<void>();
    const reading = ownership.withConsistentRead({
      archiveId: "synthetic-archive",
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;

    await expect(ownership.withWriter({
      archiveId: "synthetic-archive",
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    })).rejects.toMatchObject({ code: "WRITER_NOT_QUIESCENT" });

    release.resolve();
    await reading;
    await expect(ownership.withWriter({
      archiveId: "synthetic-archive",
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    })).resolves.toBeUndefined();
  });

  it("reports the live writer separately from its worker claim", async () => {
    const ownership = createArchiveImageOwnership();
    const originalsLibraryPath = root();
    const entered = deferred<void>();
    const release = deferred<void>();
    const writing = ownership.withWriter({
      archiveId: "synthetic-archive",
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;

    expect(ownership.inspect({
      archiveId: "synthetic-archive",
      originalsLibraryPath,
    })).toMatchObject({
      writer: { state: "active" },
      workerClaim: { state: "active" },
      stableRead: {
        available: false,
        blockingReasons: [{ code: "WRITER_NOT_QUIESCENT" }],
      },
    });

    release.resolve();
    await writing;
    expect(ownership.inspect({
      archiveId: "synthetic-archive",
      originalsLibraryPath,
    })).toMatchObject({
      writer: { state: "inactive" },
      workerClaim: { state: "none" },
      stableRead: { available: true, blockingReasons: [] },
    });
  });

  it("fails closed when the named lock inode changes", async () => {
    const ownership = createArchiveImageOwnership({
      ownershipCheckIntervalMs: 10,
    });
    const originalsLibraryPath = root();

    await expect(ownership.withWriter({
      archiveId: "synthetic-archive",
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ signal }) {
        const directory = join(
          originalsLibraryPath,
          ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME,
        );
        const lockName = (await import("node:fs/promises"))
          .readdir(directory)
          .then((entries) => entries.find((entry) => entry.endsWith(".lock"))!);
        const lockPath = join(directory, await lockName);
        renameSync(lockPath, `${lockPath}.replaced`);
        writeFileSync(lockPath, "replacement", { mode: 0o600 });
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          setTimeout(resolve, 1_000);
        });
      },
    })).rejects.toBeInstanceOf(ArchiveImageOwnershipError);
  });
});
