import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import {
  ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME,
  ARCHIVE_IMAGE_OWNERSHIP_NAMESPACE_IDENTITY_NAME,
  createArchiveImageOwnership as createArchiveImageOwnershipBase,
} from "./archive-image-ownership.js";
import { inspectLinuxStorage } from "./linux-storage.js";

const roots: string[] = [];
const helperPids: number[] = [];
const processStorageSupported = process.platform === "linux" &&
  inspectLinuxStorage(tmpdir()).filesystemType === "ext";

function createArchiveImageOwnership(
  options?: Parameters<typeof createArchiveImageOwnershipBase>[0],
): ReturnType<typeof createArchiveImageOwnershipBase> {
  const ownership = createArchiveImageOwnershipBase({
    inspectStorage: inspectLinuxStorage,
    ...options,
  });
  const initialized = new Set<string>();
  const keyFor = (request: { archiveId: string; originalsLibraryPath: string }) =>
    `${request.originalsLibraryPath}\0${request.archiveId}`;
  const initialize = async (
    request: Parameters<typeof ownership.withConsistentRead>[0],
  ) => {
    const key = keyFor(request);
    if (initialized.has(key)) return;
    await ownership.withInitialPublicationWriter({
      ...request,
      async task() {},
    });
    initialized.add(key);
  };
  return {
    ...ownership,
    async withConsistentRead(request) {
      await initialize(request);
      return ownership.withConsistentRead(request);
    },
    async withWriter(request) {
      const key = keyFor(request);
      if (initialized.has(key)) return ownership.withWriter(request);
      const result = await ownership.withInitialPublicationWriter(request);
      initialized.add(key);
      return result;
    },
  };
}

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
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("Helper did not become ready");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForFileGrowth(path: string, size: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path) || statSync(path).size <= size) {
    if (Date.now() >= deadline) throw new Error("Helper stopped writing");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function withDeadline<Result>(
  promise: Promise<Result>,
  message: string,
): Promise<Result> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runContender(
  mode: "withConsistentRead" | "withWriter",
  originalsLibraryPath: string,
  imagePath: string,
  archiveId: string,
  authorityRootPath = originalsLibraryPath,
): Promise<{ ok: boolean; code?: string | null }> {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL(
        "./test/archive-image-ownership-contender.mjs",
        import.meta.url,
      )),
      mode,
      originalsLibraryPath,
      imagePath,
      archiveId,
      authorityRootPath,
    ],
    {
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const [code] = await once(child, "close") as [number | null];
  if (code !== 0) throw new Error(`Contender exited with ${code}`);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    ok: boolean;
    code?: string | null;
  };
}

function lockPath(originalsLibraryPath: string): string {
  const directory = join(
    originalsLibraryPath,
    ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME,
  );
  const name = readdirSync(directory).find((entry) => entry.endsWith(".lock"));
  if (name === undefined) throw new Error("Ownership lock is missing");
  return join(directory, name);
}

it.runIf(processStorageSupported)(
  "retains writer exclusion in the actual helper after the parent dies and reports an expired claim",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const readyPath = join(originalsLibraryPath, "helper.ready");
    const writePath = join(originalsLibraryPath, "helper.writes");
    const imagePath = join(originalsLibraryPath, "synthetic-archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const parent = spawn(
      process.execPath,
      [
        fileURLToPath(new URL(
          "./test/archive-image-ownership-parent.mjs",
          import.meta.url,
        )),
        originalsLibraryPath,
        imagePath,
        readyPath,
        writePath,
        originalsLibraryPath,
      ],
      {
        env: { ...process.env, NODE_ENV: "production" },
        stdio: "ignore",
      },
    );
    await waitForFile(readyPath);
    await waitForFile(writePath);
    helperPids.push(Number(readFileSync(readyPath, "utf8")));
    const sizeBeforeParentExit = statSync(writePath).size;
    const parentClosed = once(parent, "close");
    if (!parent.kill("SIGKILL")) {
      throw new Error("Parent could not be terminated");
    }
    await withDeadline(parentClosed, "Parent did not terminate");
    await waitForFileGrowth(writePath, sizeBeforeParentExit);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const ownership = createArchiveImageOwnershipBase({
      inspectStorage: inspectLinuxStorage,
    });
    expect(ownership.inspect({
      archiveId: "surviving-helper-archive",
      imagePath,
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
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {},
    })).rejects.toMatchObject({ code: "WRITER_NOT_QUIESCENT" });
  },
  30_000,
);

it.runIf(processStorageSupported)(
  "fails closed when every per-archive record disappears during a live helper",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const readyPath = join(originalsLibraryPath, "helper.ready");
    const writePath = join(originalsLibraryPath, "helper.writes");
    const imagePath = join(originalsLibraryPath, "synthetic-archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const parent = spawn(
      process.execPath,
      [
        fileURLToPath(new URL(
          "./test/archive-image-ownership-parent.mjs",
          import.meta.url,
        )),
        originalsLibraryPath,
        imagePath,
        readyPath,
        writePath,
        originalsLibraryPath,
      ],
      {
        env: { ...process.env, NODE_ENV: "production" },
        stdio: "ignore",
      },
    );
    if (parent.pid !== undefined) helperPids.push(parent.pid);
    await waitForFile(readyPath);
    await waitForFile(writePath);
    helperPids.push(Number(readFileSync(readyPath, "utf8")));

    const directory = join(
      originalsLibraryPath,
      ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME,
    );
    const removeTriplet = () => {
      for (const entry of readdirSync(directory)) {
        if (
          entry.endsWith(".lock") ||
          entry.endsWith(".identity.json") ||
          entry.endsWith(".claim.json")
        ) {
          rmSync(join(directory, entry), { force: true });
        }
      }
      for (const entry of readdirSync(originalsLibraryPath)) {
        if (
          entry.startsWith(".rip-dvd-archive-ownership.archive-") &&
          entry.endsWith(".identity.json")
        ) {
          rmSync(join(originalsLibraryPath, entry), { force: true });
        }
      }
    };
    const sizeBeforeRemoval = statSync(writePath).size;
    removeTriplet();
    await waitForFileGrowth(writePath, sizeBeforeRemoval);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    removeTriplet();

    const ownership = createArchiveImageOwnership();
    expect(ownership.inspect({
      archiveId: "surviving-helper-archive",
      imagePath,
      originalsLibraryPath,
    })).toMatchObject({
      writer: { state: "uncertain" },
      workerClaim: { state: "invalid" },
      stableRead: {
        available: false,
        blockingReasons: [{ code: "CONSISTENCY_FAULT" }],
      },
    });

    await expect(runContender(
      "withConsistentRead",
      originalsLibraryPath,
      imagePath,
      "surviving-helper-archive",
    )).resolves.toEqual({ ok: false, code: "CONSISTENCY_FAULT" });
    await expect(runContender(
      "withWriter",
      originalsLibraryPath,
      imagePath,
      "surviving-helper-archive",
    )).resolves.toEqual({ ok: false, code: "CONSISTENCY_FAULT" });
  },
  30_000,
);

it.runIf(processStorageSupported)(
  "excludes a writer in another process for the complete shared interval",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const imagePath = join(originalsLibraryPath, "synthetic-archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const ownership = createArchiveImageOwnership();

    await ownership.withConsistentRead({
      archiveId: "cross-process-reader-archive",
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        await expect(runContender(
          "withWriter",
          originalsLibraryPath,
          imagePath,
          "cross-process-reader-archive",
        )).resolves.toEqual({ ok: false, code: "WRITER_NOT_QUIESCENT" });
      },
    });
  },
);

it.runIf(processStorageSupported)(
  "blocks a second process after the named lock inode is replaced",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const imagePath = join(originalsLibraryPath, "synthetic-archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const ownership = createArchiveImageOwnership({
      ownershipCheckIntervalMs: 60_000,
    });

    await expect(ownership.withWriter({
      archiveId: "replaced-lock-archive",
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ assertOwned }) {
        const path = lockPath(originalsLibraryPath);
        renameSync(path, `${path}.replaced`);
        writeFileSync(path, "replacement", { mode: 0o600 });
        await expect(runContender(
          "withWriter",
          originalsLibraryPath,
          imagePath,
          "replaced-lock-archive",
        )).resolves.toEqual({ ok: false, code: "CONSISTENCY_FAULT" });
        assertOwned();
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });

    expect(ownership.inspect({
      archiveId: "replaced-lock-archive",
      imagePath,
      originalsLibraryPath,
    })).toMatchObject({
      writer: { state: "uncertain" },
      workerClaim: { state: "active" },
      stableRead: {
        available: false,
        blockingReasons: [{ code: "CONSISTENCY_FAULT" }],
      },
    });
  },
);

it.runIf(processStorageSupported)(
  "blocks a writer after the named lock is replaced during a shared interval",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const imagePath = join(originalsLibraryPath, "synthetic-archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const ownership = createArchiveImageOwnership({
      ownershipCheckIntervalMs: 60_000,
    });

    await expect(ownership.withConsistentRead({
      archiveId: "replaced-reader-lock-archive",
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ assertOwned }) {
        const path = lockPath(originalsLibraryPath);
        renameSync(path, `${path}.replaced`);
        writeFileSync(path, "replacement", { mode: 0o600 });
        await expect(runContender(
          "withWriter",
          originalsLibraryPath,
          imagePath,
          "replaced-reader-lock-archive",
        )).resolves.toEqual({ ok: false, code: "CONSISTENCY_FAULT" });
        assertOwned();
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });

    expect(ownership.inspect({
      archiveId: "replaced-reader-lock-archive",
      imagePath,
      originalsLibraryPath,
    })).toMatchObject({
      writer: { state: "uncertain" },
      workerClaim: { state: "none" },
      stableRead: {
        available: false,
        blockingReasons: [{ code: "CONSISTENCY_FAULT" }],
      },
    });
  },
);

it.runIf(processStorageSupported)(
  "does not mistake a competing shared flock for the released reader's lock",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const imagePath = join(originalsLibraryPath, "synthetic-archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const ownership = createArchiveImageOwnership({
      ownershipCheckIntervalMs: 60_000,
    });

    await expect(ownership.withConsistentRead({
      archiveId: "unlocked-reader-archive",
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ descriptor, assertOwned }) {
        const unlocked = spawnSync("flock", ["--unlock", "3"], {
          stdio: ["ignore", "ignore", "ignore", descriptor],
        });
        expect(unlocked.status).toBe(0);
        const rival = openSync(lockPath(originalsLibraryPath), "r+");
        try {
          const locked = spawnSync("flock", ["--shared", "--nonblock", "3"], {
            stdio: ["ignore", "ignore", "ignore", rival],
          });
          expect(locked.status).toBe(0);
          assertOwned();
        } finally {
          closeSync(rival);
        }
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
  },
);

it.runIf(processStorageSupported)(
  "does not mistake a competing exclusive flock for the released writer's lock",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const imagePath = join(originalsLibraryPath, "synthetic-archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const ownership = createArchiveImageOwnership({
      ownershipCheckIntervalMs: 60_000,
    });

    await expect(ownership.withWriter({
      archiveId: "unlocked-writer-archive",
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ descriptor, assertOwned }) {
        const unlocked = spawnSync("flock", ["--unlock", "3"], {
          stdio: ["ignore", "ignore", "ignore", descriptor],
        });
        expect(unlocked.status).toBe(0);
        const rival = openSync(lockPath(originalsLibraryPath), "r+");
        try {
          const locked = spawnSync(
            "flock",
            ["--exclusive", "--nonblock", "3"],
            { stdio: ["ignore", "ignore", "ignore", rival] },
          );
          expect(locked.status).toBe(0);
          assertOwned();
        } finally {
          closeSync(rival);
        }
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
  },
);

it.runIf(processStorageSupported)(
  "retains the writer claim when a helper rejects immediately after lock loss",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const imagePath = join(originalsLibraryPath, "synthetic-archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const ownership = createArchiveImageOwnership({
      ownershipCheckIntervalMs: 60_000,
    });

    await expect(ownership.withWriter({
      archiveId: "rejected-helper-archive",
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ descriptor }) {
        const unlocked = spawnSync("flock", ["--unlock", "3"], {
          stdio: ["ignore", "ignore", "ignore", descriptor],
        });
        expect(unlocked.status).toBe(0);
        throw new Error("synthetic helper failure");
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });

    expect(ownership.inspect({
      archiveId: "rejected-helper-archive",
      imagePath,
      originalsLibraryPath,
    })).toMatchObject({
      workerClaim: { state: "active" },
      stableRead: {
        available: false,
        blockingReasons: [{ code: "CONSISTENCY_FAULT" }],
      },
    });
  },
);

it.runIf(processStorageSupported)(
  "does not poison archive locks during concurrent fresh-namespace initialization",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const imagePath = join(originalsLibraryPath, "synthetic-archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const ownership = createArchiveImageOwnershipBase({
      inspectStorage: inspectLinuxStorage,
    });

    const requests = Array.from(
      { length: 8 },
      (_unused, index) => ({
        archiveId: `fresh-namespace-archive-${index}`,
        imagePath,
        originalsLibraryPath,
        signal: new AbortController().signal,
        async task() {},
      }),
    );
    const firstAttempts = await Promise.allSettled(
      requests.map((request) =>
        ownership.withInitialPublicationWriter(request)
      ),
    );
    for (const [index, request] of requests.entries()) {
      if (firstAttempts[index]?.status !== "fulfilled") {
        await expect(ownership.withInitialPublicationWriter(request))
          .resolves.toBeUndefined();
      }
    }
    await Promise.all(requests.map((request) =>
      expect(ownership.withConsistentRead(request)).resolves.toBeUndefined()
    ));
  },
);

it.runIf(processStorageSupported)(
  "blocks a second namespace after the ownership directory is replaced",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const imagePath = join(originalsLibraryPath, "synthetic-archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const ownership = createArchiveImageOwnership({
      ownershipCheckIntervalMs: 60_000,
    });

    await expect(ownership.withWriter({
      archiveId: "replaced-directory-archive",
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ assertOwned }) {
        const directory = join(
          originalsLibraryPath,
          ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME,
        );
        renameSync(directory, `${directory}.replaced`);
        mkdirSync(directory, { mode: 0o700 });
        await expect(runContender(
          "withWriter",
          originalsLibraryPath,
          imagePath,
          "replaced-directory-archive",
        )).resolves.toEqual({ ok: false, code: "CONSISTENCY_FAULT" });
        assertOwned();
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
  },
);

it.runIf(processStorageSupported)(
  "blocks a second namespace after the Originals root is replaced",
  async () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(testRoot);
    const originalsLibraryPath = join(testRoot, "originals");
    const authorityRootPath = join(testRoot, "authority");
    mkdirSync(originalsLibraryPath, { mode: 0o700 });
    mkdirSync(authorityRootPath, { mode: 0o700 });
    const imagePath = join(testRoot, "synthetic-archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const ownership = createArchiveImageOwnership({
      authorityRootPath,
      ownershipCheckIntervalMs: 60_000,
    });

    await expect(ownership.withWriter({
      archiveId: "replaced-root-archive",
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ assertOwned }) {
        renameSync(originalsLibraryPath, `${originalsLibraryPath}.replaced`);
        mkdirSync(originalsLibraryPath, { mode: 0o700 });
        await expect(runContender(
          "withWriter",
          originalsLibraryPath,
          imagePath,
          "replaced-root-archive",
          authorityRootPath,
        )).resolves.toEqual({ ok: false, code: "CONSISTENCY_FAULT" });
        assertOwned();
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
  },
);

it.runIf(processStorageSupported)(
  "blocks a second namespace after the ownership authority root is replaced",
  async () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(testRoot);
    const originalsLibraryPath = join(testRoot, "originals");
    const authorityRootPath = join(testRoot, "authority");
    mkdirSync(originalsLibraryPath, { mode: 0o700 });
    mkdirSync(authorityRootPath, { mode: 0o700 });
    const imagePath = join(testRoot, "synthetic-archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const ownership = createArchiveImageOwnership({
      authorityRootPath,
      ownershipCheckIntervalMs: 60_000,
    });

    await expect(ownership.withWriter({
      archiveId: "replaced-authority-archive",
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ assertOwned }) {
        renameSync(authorityRootPath, `${authorityRootPath}.replaced`);
        mkdirSync(authorityRootPath, { mode: 0o700 });
        await expect(runContender(
          "withWriter",
          originalsLibraryPath,
          imagePath,
          "replaced-authority-archive",
          authorityRootPath,
        )).resolves.toEqual({ ok: false, code: "CONSISTENCY_FAULT" });
        assertOwned();
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
  },
);

it.runIf(processStorageSupported)(
  "blocks rebootstrap after the ownership directory and authority identity move together",
  async () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(testRoot);
    const originalsLibraryPath = join(testRoot, "originals");
    const authorityRootPath = join(testRoot, "authority");
    mkdirSync(originalsLibraryPath, { mode: 0o700 });
    mkdirSync(authorityRootPath, { mode: 0o700 });
    const imagePath = join(testRoot, "synthetic-archive.iso");
    writeFileSync(imagePath, "synthetic image", { mode: 0o600 });
    const ownership = createArchiveImageOwnership({
      authorityRootPath,
      ownershipCheckIntervalMs: 60_000,
    });

    await expect(ownership.withWriter({
      archiveId: "moved-authority-pair-archive",
      imagePath,
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ assertOwned }) {
        const directory = join(
          authorityRootPath,
          ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME,
        );
        const identity = join(
          authorityRootPath,
          ARCHIVE_IMAGE_OWNERSHIP_NAMESPACE_IDENTITY_NAME,
        );
        renameSync(directory, `${directory}.replaced`);
        renameSync(identity, `${identity}.replaced`);
        mkdirSync(directory, { mode: 0o700 });
        await expect(runContender(
          "withWriter",
          originalsLibraryPath,
          imagePath,
          "moved-authority-pair-archive",
          authorityRootPath,
        )).resolves.toEqual({ ok: false, code: "CONSISTENCY_FAULT" });
        assertOwned();
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });
  },
);
