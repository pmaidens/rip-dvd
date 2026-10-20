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
  createArchiveImageOwnership as createArchiveImageOwnershipBase,
} from "./archive-image-ownership.js";

const roots: string[] = [];

function createArchiveImageOwnership(
  options?: Parameters<typeof createArchiveImageOwnershipBase>[0],
): ReturnType<typeof createArchiveImageOwnershipBase> {
  const ownership = createArchiveImageOwnershipBase(options);
  return {
    ...ownership,
    withConsistentRead: request => ownership.withConsistentRead({
      ...request,
      initialize: true,
    }),
    withWriter: request => ownership.withWriter({
      ...request,
      initialize: true,
    }),
  };
}

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
  it("fails inspection closed before the ownership namespace exists", () => {
    const originalsLibraryPath = root();
    const ownership = createArchiveImageOwnershipBase();

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
  });

  it("fails inspection closed for an unregistered archive", async () => {
    const originalsLibraryPath = root();
    const ownership = createArchiveImageOwnership();
    await ownership.withWriter({
      archiveId: "initialized-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    });

    expect(ownership.inspect({
      archiveId: "unregistered-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
    })).toMatchObject({
      writer: { state: "uncertain" },
      stableRead: {
        available: false,
        blockingReasons: [{ code: "CONSISTENCY_FAULT" }],
      },
    });
  });

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

  it("classifies an archive image outside the library root", async () => {
    const originalsLibraryPath = root();
    const imagePath = join(root(), "archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
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

    await expect(ownership.withConsistentRead({
      archiveId: "synthetic-archive",
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
    expect(inspectedPaths).toContain(realpathSync(imagePath));
  });

  it("classifies every image path used during an ownership interval", async () => {
    const originalsLibraryPath = root();
    const primaryImagePath = join(originalsLibraryPath, "staging.iso");
    const additionalImagePath = join(originalsLibraryPath, "published.iso");
    writeFileSync(primaryImagePath, "synthetic staging image", { mode: 0o600 });
    writeFileSync(additionalImagePath, "synthetic published image", { mode: 0o600 });
    const ownership = createArchiveImageOwnership({
      inspectStorage: (path) => path === realpathSync(additionalImagePath)
        ? { filesystemType: "synthetic-network", storageClass: "network" }
        : { filesystemType: "test-in-process", storageClass: "local" },
    });

    await expect(ownership.withWriter({
      archiveId: "synthetic-archive",
      additionalImagePaths: [additionalImagePath],
      imagePath: primaryImagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
  });

  it.each(["directory", "lock"] as const)(
    "fails closed when the actual ownership %s is on unsupported storage",
    async (unsupportedPath) => {
      const originalsLibraryPath = root();
      const directory = join(
        realpathSync(originalsLibraryPath),
        ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME,
      );
      const ownership = createArchiveImageOwnership({
        inspectStorage: (path) => {
          const unsupported = unsupportedPath === "directory"
            ? path === directory
            : path.endsWith(".lock");
          return unsupported
            ? { filesystemType: "synthetic-network", storageClass: "network" }
            : { filesystemType: "test-in-process", storageClass: "local" };
        },
      });

      await expect(ownership.withWriter({
        archiveId: "synthetic-archive",
        imagePath: originalsLibraryPath,
        originalsLibraryPath,
        signal: new AbortController().signal,
        async task() {},
      })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
    },
  );

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

  it.each(["directory", "lock"] as const)(
    "fails closed when the ownership %s becomes publicly accessible",
    async (changedPath) => {
      const originalsLibraryPath = root();
      const ownership = createArchiveImageOwnership();

      await expect(ownership.withWriter({
        archiveId: "synthetic-archive",
        imagePath: originalsLibraryPath,
        originalsLibraryPath,
        signal: new AbortController().signal,
        async task({ assertOwned }) {
          const path = changedPath === "directory"
            ? join(
              originalsLibraryPath,
              ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME,
            )
            : ownershipFile(originalsLibraryPath, ".lock");
          chmodSync(path, 0o755);
          assertOwned();
        },
      })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
    },
  );

  it("normalizes a post-acquisition storage inspection failure", async () => {
    let inspections = 0;
    const ownership = createArchiveImageOwnership({
      inspectStorage: () => {
        inspections += 1;
        if (inspections === 6) throw new Error("synthetic storage failure");
        return { filesystemType: "test-in-process", storageClass: "local" };
      },
    });
    const originalsLibraryPath = root();

    await expect(ownership.withConsistentRead({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
  });

  it("revalidates archive identity after lock acquisition before starting work", async () => {
    const originalsLibraryPath = root();
    const held = new Set<number>();
    let taskCalled = false;
    const ownership = createArchiveImageOwnership({
      backend: {
        supported: true,
        async acquire(descriptor, lockPath) {
          held.add(descriptor);
          if (lockPath.endsWith(".lock")) {
            const anchor = readdirSync(originalsLibraryPath).find((entry) =>
              entry.startsWith(".rip-dvd-archive-ownership.archive-") &&
              entry.endsWith(".identity.json")
            );
            if (anchor === undefined) throw new Error("Archive anchor is missing");
            rmSync(join(originalsLibraryPath, anchor));
          }
          return () => held.delete(descriptor);
        },
        assertHeld(descriptor) {
          if (!held.has(descriptor)) {
            throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
          }
        },
        inspect() {
          return "inactive";
        },
      },
    });

    await expect(ownership.withWriter({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        taskCalled = true;
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
    expect(taskCalled).toBe(false);
  });

  it("surfaces a pending heartbeat failure after protected work completes", async () => {
    const originalsLibraryPath = root();
    const heartbeatStarted = deferred<void>();
    const rejectHeartbeat = deferred<void>();
    const taskFinished = deferred<void>();
    const ownership = createArchiveImageOwnership({
      claimLeaseDurationMs: 30,
      async writeHeartbeatRecord() {
        heartbeatStarted.resolve();
        await rejectHeartbeat.promise;
        throw new Error("synthetic heartbeat failure");
      },
    });

    const result = ownership.withWriter({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        await heartbeatStarted.promise;
        taskFinished.resolve();
      },
    });
    await taskFinished.promise;
    rejectHeartbeat.resolve();
    await expect(result).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
    expect(ownership.inspect({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
    })).toMatchObject({
      workerClaim: { state: "active" },
      stableRead: {
        available: false,
        blockingReasons: [{ code: "CONSISTENCY_FAULT" }],
      },
    });
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

  it("reports an invalid live-writer claim as a consistency fault", async () => {
    const ownership = createArchiveImageOwnership({
      claimLeaseDurationMs: 30_000,
    });
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
    const lockPath = ownershipFile(originalsLibraryPath, ".lock");
    writeFileSync(lockPath.replace(/\.lock$/, ".claim.json"), "{}\n", {
      mode: 0o600,
    });

    expect(ownership.inspect({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
    })).toMatchObject({
      writer: { state: "active" },
      workerClaim: { state: "invalid" },
      stableRead: {
        available: false,
        blockingReasons: [{ code: "CONSISTENCY_FAULT" }],
      },
    });

    release.resolve();
    await writing;
  });

  it("fails inspection closed when the registry changes during inspection", async () => {
    const originalsLibraryPath = root();
    const held = new Set<number>();
    let replaceRegistry = false;
    const ownership = createArchiveImageOwnership({
      backend: {
        supported: true,
        async acquire(descriptor) {
          held.add(descriptor);
          return () => held.delete(descriptor);
        },
        assertHeld(descriptor) {
          if (!held.has(descriptor)) {
            throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
          }
        },
        inspect() {
          if (replaceRegistry) {
            replaceRegistry = false;
            const registryPath = join(
              originalsLibraryPath,
              ".rip-dvd-archive-ownership.registry",
            );
            const contents = readFileSync(registryPath);
            renameSync(registryPath, `${registryPath}.replaced`);
            writeFileSync(registryPath, contents, { mode: 0o600 });
          }
          return "inactive";
        },
      },
    });
    await ownership.withWriter({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    });
    replaceRegistry = true;

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

  it("rejects an expired-looking claim with an impossible timeline", async () => {
    const ownership = createArchiveImageOwnership();
    const originalsLibraryPath = root();
    let claimPath = "";
    let claim: Record<string, unknown> = {};
    await ownership.withWriter({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        claimPath = ownershipFile(originalsLibraryPath, ".claim.json");
        claim = JSON.parse(readFileSync(claimPath, "utf8")) as Record<
          string,
          unknown
        >;
      },
    });
    writeFileSync(claimPath, `${JSON.stringify({
      ...claim,
      claimedAt: "2999-01-01T00:00:00.000Z",
      heartbeatAt: "2000-01-02T00:00:00.000Z",
      leaseExpiresAt: "2000-01-01T00:00:00.000Z",
    })}\n`, { mode: 0o600 });

    expect(ownership.inspect({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
    })).toMatchObject({
      workerClaim: { state: "invalid" },
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
  });

  it("rejects noncanonical claim timestamps", async () => {
    const ownership = createArchiveImageOwnership();
    const originalsLibraryPath = root();
    let claimPath = "";
    let claim: Record<string, unknown> = {};
    await ownership.withWriter({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        claimPath = ownershipFile(originalsLibraryPath, ".claim.json");
        claim = JSON.parse(readFileSync(claimPath, "utf8")) as Record<
          string,
          unknown
        >;
      },
    });
    writeFileSync(claimPath, `${JSON.stringify({
      ...claim,
      claimedAt: "2000-01-01T00:00:00Z",
      heartbeatAt: "2000-01-01T00:00:01Z",
      leaseExpiresAt: "2000-01-01T00:00:02Z",
    })}\n`, { mode: 0o600 });

    expect(ownership.inspect({
      archiveId: "synthetic-archive",
      imagePath: originalsLibraryPath,
      originalsLibraryPath,
    })).toMatchObject({
      workerClaim: { state: "invalid" },
      stableRead: {
        available: false,
        blockingReasons: [{ code: "CONSISTENCY_FAULT" }],
      },
    });
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
