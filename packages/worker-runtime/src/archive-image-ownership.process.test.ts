import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
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
  createArchiveImageOwnership,
} from "./archive-image-ownership.js";

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
  archiveId: string,
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
      archiveId,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
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

it.runIf(process.platform === "linux")(
  "retains writer exclusion in the actual helper after the parent dies and reports an expired claim",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const readyPath = join(originalsLibraryPath, "helper.ready");
    const writePath = join(originalsLibraryPath, "helper.writes");
    const parent = spawn(
      process.execPath,
      [
        fileURLToPath(new URL(
          "./test/archive-image-ownership-parent.mjs",
          import.meta.url,
        )),
        originalsLibraryPath,
        readyPath,
        writePath,
      ],
      { stdio: "ignore" },
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
  30_000,
);

it.runIf(process.platform === "linux")(
  "excludes a writer in another process for the complete shared interval",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const ownership = createArchiveImageOwnership();

    await ownership.withConsistentRead({
      archiveId: "cross-process-reader-archive",
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task() {
        await expect(runContender(
          "withWriter",
          originalsLibraryPath,
          "cross-process-reader-archive",
        )).resolves.toEqual({ ok: false, code: "WRITER_NOT_QUIESCENT" });
      },
    });
  },
);

it.runIf(process.platform === "linux")(
  "blocks a second process after the named lock inode is replaced",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const ownership = createArchiveImageOwnership({
      ownershipCheckIntervalMs: 60_000,
    });

    await expect(ownership.withWriter({
      archiveId: "replaced-lock-archive",
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ assertOwned }) {
        const path = lockPath(originalsLibraryPath);
        renameSync(path, `${path}.replaced`);
        writeFileSync(path, "replacement", { mode: 0o600 });
        await expect(runContender(
          "withWriter",
          originalsLibraryPath,
          "replaced-lock-archive",
        )).resolves.toEqual({ ok: false, code: "CONSISTENCY_FAULT" });
        assertOwned();
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });

    expect(ownership.inspect({
      archiveId: "replaced-lock-archive",
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

it.runIf(process.platform === "linux")(
  "blocks a writer after the named lock is replaced during a shared interval",
  async () => {
    const originalsLibraryPath = mkdtempSync(
      join(tmpdir(), "rip-dvd-image-ownership-process-"),
    );
    roots.push(originalsLibraryPath);
    const ownership = createArchiveImageOwnership({
      ownershipCheckIntervalMs: 60_000,
    });

    await expect(ownership.withConsistentRead({
      archiveId: "replaced-reader-lock-archive",
      originalsLibraryPath,
      signal: new AbortController().signal,
      async task({ assertOwned }) {
        const path = lockPath(originalsLibraryPath);
        renameSync(path, `${path}.replaced`);
        writeFileSync(path, "replacement", { mode: 0o600 });
        await expect(runContender(
          "withWriter",
          originalsLibraryPath,
          "replaced-reader-lock-archive",
        )).resolves.toEqual({ ok: false, code: "CONSISTENCY_FAULT" });
        assertOwned();
      },
    })).rejects.toMatchObject({ code: "CONSISTENCY_FAULT" });

    expect(ownership.inspect({
      archiveId: "replaced-reader-lock-archive",
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
