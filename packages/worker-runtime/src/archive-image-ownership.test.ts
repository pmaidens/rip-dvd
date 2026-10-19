import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

function ownershipFile(
  originalsLibraryPath: string,
  suffix: ".claim.json" | ".lock",
): string {
  const directory = join(
    originalsLibraryPath,
    ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME,
  );
  const name = readdirSync(directory).find((entry) => entry.endsWith(suffix));
  if (name === undefined) throw new Error(`Missing ownership ${suffix} file`);
  return join(directory, name);
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("archive image ownership", () => {
  it.each(["network", "unknown"] as const)(
    "fails closed on %s storage",
    async (storageClass) => {
      const ownership = createArchiveImageOwnership({
        inspectStorage: () => ({
          filesystemType: `synthetic-${storageClass}`,
          storageClass,
        }),
      });
      const originalsLibraryPath = root();

      expect(ownership.inspect({
        archiveId: "synthetic-archive",
        imagePath: originalsLibraryPath,
        originalsLibraryPath,
      })).toMatchObject({
        writer: { state: "uncertain" },
        stableRead: {
          available: false,
          blockingReasons: [{ code: "CONSISTENCY_FAULT" }],
        },
      });
      await expect(ownership.withConsistentRead({
        archiveId: "synthetic-archive",
        imagePath: originalsLibraryPath,
        originalsLibraryPath,
        signal: new AbortController().signal,
        async task() {},
      })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
    },
  );

  it.each(["xfs", "btrfs"] as const)(
    "keeps unverified local %s ownership storage closed",
    async (filesystemType) => {
      const ownership = createArchiveImageOwnership({
        inspectStorage: () => ({ filesystemType, storageClass: "local" }),
      });
      const originalsLibraryPath = root();

      await expect(ownership.withConsistentRead({
        archiveId: "synthetic-archive",
        imagePath: originalsLibraryPath,
        originalsLibraryPath,
        signal: new AbortController().signal,
        async task() {},
      })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
    },
  );

  it("classifies the archive image instead of only the library root", async () => {
    const originalsLibraryPath = root();
    const imagePath = join(originalsLibraryPath, "mounted", "archive.iso");
    const inspectedPaths: string[] = [];
    const ownership = createArchiveImageOwnership({
      inspectStorage: (path) => {
        inspectedPaths.push(path);
        const isImage = path === realpathSync(imagePath);
        return {
          filesystemType: isImage ? "synthetic-network" : "test-in-process",
          storageClass: isImage ? "network" : "local",
        };
      },
    });
    mkdirSync(dirname(imagePath), { mode: 0o700 });
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });

    await expect(ownership.withConsistentRead({
      archiveId: "synthetic-archive",
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
    expect(inspectedPaths).toContain(realpathSync(imagePath));
  });

  it("classifies the library root before an archive image exists", async () => {
    const originalsLibraryPath = root();
    const inspectedPaths: string[] = [];
    const ownership = createArchiveImageOwnership({
      inspectStorage: (path) => {
        inspectedPaths.push(path);
        return { filesystemType: "test-in-process", storageClass: "local" };
      },
    });

    await ownership.withWriter({
      archiveId: "synthetic-archive",
      imagePath: null,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    });

    expect(inspectedPaths).toContain(realpathSync(originalsLibraryPath));
  });

  it("rejects an archive image outside the library root", async () => {
    const originalsLibraryPath = root();
    const imagePath = join(root(), "archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const ownership = createArchiveImageOwnership();

    await expect(ownership.withConsistentRead({
      archiveId: "synthetic-archive",
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
  });

  it("fails closed when local storage changes during an interval", async () => {
    let storageClass: "local" | "network" = "local";
    const ownership = createArchiveImageOwnership({
      inspectStorage: () => ({
        filesystemType: storageClass === "local"
          ? "test-in-process"
          : `synthetic-${storageClass}`,
        storageClass,
      }),
    });
    const originalsLibraryPath = root();

    await expect(ownership.withConsistentRead({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ assertOwned }) {
        storageClass = "network";
        assertOwned();
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
  });

  it("excludes writers from a shared consistent-read interval", async () => {
    const ownership = createArchiveImageOwnership();
    const originalsLibraryPath = root();
    const entered = deferred<void>();
    const release = deferred<void>();
    const reading = ownership.withConsistentRead({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
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
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    })).rejects.toMatchObject({ code: "WRITER_NOT_QUIESCENT" });

    release.resolve();
    await reading;
    await expect(ownership.withWriter({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
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
      imagePath: originalsLibraryPath,
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
      imagePath: originalsLibraryPath,
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
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
    })).toMatchObject({
      writer: { state: "inactive" },
      workerClaim: { state: "none" },
      stableRead: { available: true, blockingReasons: [] },
    });
  });

  it("rejects a stable read while a retained active claim is unproven", async () => {
    const ownership = createArchiveImageOwnership();
    const originalsLibraryPath = root();
    let claimPath = "";
    let claimContents = "";
    await ownership.withWriter({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        claimPath = ownershipFile(originalsLibraryPath, ".claim.json");
        claimContents = readFileSync(claimPath, "utf8");
      },
    });
    writeFileSync(claimPath, claimContents, { mode: 0o600 });

    await expect(ownership.withConsistentRead({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
  });

  it("rejects a stable read when the worker claim is invalid", async () => {
    const ownership = createArchiveImageOwnership();
    const originalsLibraryPath = root();
    await ownership.withConsistentRead({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    });
    const lockPath = ownershipFile(originalsLibraryPath, ".lock");
    writeFileSync(lockPath.replace(/\.lock$/, ".claim.json"), "{}\n", {
      mode: 0o600,
    });

    await expect(ownership.withConsistentRead({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
  });

  it("fails closed when the named lock inode changes", async () => {
    const ownership = createArchiveImageOwnership({
      ownershipCheckIntervalMs: 10,
    });
    const originalsLibraryPath = root();

    await expect(ownership.withWriter({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ signal }) {
        const lockPath = ownershipFile(originalsLibraryPath, ".lock");
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

    expect(ownership.inspect({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
    })).toMatchObject({
      writer: { state: "uncertain" },
      workerClaim: { state: "active" },
      stableRead: {
        available: false,
        blockingReasons: [{ code: "CONSISTENCY_FAULT" }],
      },
    });
    await expect(ownership.withWriter({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
  });

  it("returns a fail-closed inspection when the lock path is unsafe", async () => {
    const ownership = createArchiveImageOwnership();
    const originalsLibraryPath = root();
    await ownership.withConsistentRead({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    });
    chmodSync(ownershipFile(originalsLibraryPath, ".lock"), 0o666);

    expect(ownership.inspect({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
    })).toMatchObject({
      writer: { state: "uncertain" },
      workerClaim: { state: "invalid" },
      stableRead: {
        available: false,
        blockingReasons: [{ code: "CONSISTENCY_FAULT" }],
      },
    });
  });
});
