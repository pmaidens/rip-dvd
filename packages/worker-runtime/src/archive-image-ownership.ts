import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  inspectLinuxStorage,
  type LinuxStorageInspection,
} from "./linux-storage.js";

export const ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME =
  ".rip-dvd-archive-ownership";
export const ARCHIVE_IMAGE_OWNERSHIP_VERSION =
  "archive-image-ownership-v1";

const ACQUISITION_TIMEOUT_MS = 5_000;
const CLAIM_LEASE_DURATION_MS = 60_000;
const OWNERSHIP_CHECK_INTERVAL_MS = 1_000;
const FLOCK_CONFLICT_EXIT_CODE = 75;
const MAX_ARCHIVE_ID_BYTES = 128;
const OWNERSHIP_NAMESPACE_IDENTITY_NAME =
  ".rip-dvd-archive-ownership.identity.json";

export type ArchiveImageOwnershipReasonCode =
  | "WRITER_NOT_QUIESCENT"
  | "CONSISTENCY_FAULT";

export class ArchiveImageOwnershipError extends Error {
  override readonly name = "ArchiveImageOwnershipError";

  constructor(
    readonly code: ArchiveImageOwnershipReasonCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export interface ArchiveImageOwnershipInspection {
  contractVersion: typeof ARCHIVE_IMAGE_OWNERSHIP_VERSION;
  writer: { state: "inactive" | "active" | "uncertain" };
  workerClaim: {
    state: "none" | "active" | "expired" | "invalid";
    claimedAt: string | null;
    leaseExpiresAt: string | null;
  };
  stableRead: {
    available: boolean;
    blockingReasons: readonly {
      code: ArchiveImageOwnershipReasonCode;
      message: string;
    }[];
  };
}

export interface ArchiveImageOwnershipHandle {
  readonly descriptor: number;
  readonly signal: AbortSignal;
  assertOwned(): void;
}

interface OwnershipRequest<Result> {
  archiveId: string;
  imagePath: string | null;
  originalsLibraryPath: string;
  signal: AbortSignal;
  task(handle: ArchiveImageOwnershipHandle): Promise<Result>;
}

export interface ArchiveImageOwnership {
  inspect(input: {
    archiveId: string;
    imagePath: string;
    originalsLibraryPath: string;
  }): ArchiveImageOwnershipInspection;
  withConsistentRead<Result>(request: OwnershipRequest<Result>): Promise<Result>;
  withWriter<Result>(request: OwnershipRequest<Result>): Promise<Result>;
}

interface WriterClaimRecord {
  version: typeof ARCHIVE_IMAGE_OWNERSHIP_VERSION;
  archiveId: string;
  claimId: string;
  claimedAt: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
  lockDevice: string;
  lockInode: string;
}

interface LockIdentity {
  lockDevice: string;
  lockInode: string;
}

interface LockIdentityRecord extends LockIdentity {
  version: typeof ARCHIVE_IMAGE_OWNERSHIP_VERSION;
  archiveId: string;
}

interface NamespaceIdentityRecord {
  version: typeof ARCHIVE_IMAGE_OWNERSHIP_VERSION;
  originalsRootDevice: string;
  originalsRootInode: string;
  directoryDevice: string;
  directoryInode: string;
}

interface OwnershipPaths {
  root: string;
  authorityRoot: string;
  directory: string;
  directoryCreated: boolean;
  namespaceIdentity: string;
  lock: string;
  identity: string;
  claim: string;
}

interface OpenedLock {
  descriptor: number;
  created: boolean;
}

interface LockBackend {
  readonly supported: boolean;
  acquire(
    descriptor: number,
    lockPath: string,
    mode: "shared" | "exclusive",
    signal: AbortSignal,
  ): Promise<() => void>;
  assertHeld(
    descriptor: number,
    lockPath: string,
    mode: "shared" | "exclusive",
  ): void;
  inspect(descriptor: number, lockPath: string): "inactive" | "active" | "uncertain";
}

interface CreateOwnershipOptions {
  acquisitionTimeoutMs?: number;
  authorityRootPath?: string;
  claimLeaseDurationMs?: number;
  ownershipCheckIntervalMs?: number;
  now?: () => Date;
  backend?: LockBackend;
  inspectStorage?: (path: string) => LinuxStorageInspection;
}

function reasonMessage(code: ArchiveImageOwnershipReasonCode): string {
  return code === "WRITER_NOT_QUIESCENT"
    ? "The archive image has a live operating-system writer."
    : "Archive image ownership or quiescence could not be proven.";
}

function requireArchiveId(archiveId: string): string {
  if (
    archiveId.length === 0 ||
    Buffer.byteLength(archiveId) > MAX_ARCHIVE_ID_BYTES
  ) {
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
  }
  return archiveId;
}

function ownershipStem(archiveId: string): string {
  return createHash("sha256")
    .update(requireArchiveId(archiveId), "utf8")
    .digest("hex");
}

function validateDirectory(path: string): void {
  const metadata = lstatSync(path);
  const effectiveUserId = process.geteuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    effectiveUserId === undefined ||
    metadata.uid !== effectiveUserId
  ) {
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
  }
}

function ownershipStorageIsSupported(
  inspection: LinuxStorageInspection,
): boolean {
  return inspection.storageClass === "local" &&
    (inspection.filesystemType === "ext" ||
      inspection.filesystemType === "test-in-process");
}

function resolveStorageProbePath(root: string, imagePath: string | null): string {
  if (imagePath === null) return root;
  if (!isAbsolute(imagePath)) {
    throw new Error("Archive image path is not absolute");
  }
  let probePath = imagePath;
  while (true) {
    try {
      return realpathSync(probePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(probePath);
    if (parent === probePath) {
      throw new Error("Archive image storage is unavailable");
    }
    probePath = parent;
  }
}

function ownershipStoragePathsAreSupported(
  root: string,
  authorityRoot: string,
  imagePath: string | null,
  inspectStorage: (path: string) => LinuxStorageInspection,
): boolean {
  const paths = new Set([
    root,
    authorityRoot,
    resolveStorageProbePath(root, imagePath),
  ]);
  return [...paths].every((path) =>
    ownershipStorageIsSupported(inspectStorage(path))
  );
}

function configuredAuthorityRoot(
  originalsRoot: string,
  authorityRootPath: string | undefined,
): string {
  const requested = authorityRootPath ?? (
    process.env.NODE_ENV === "test"
      ? originalsRoot
      : process.env.RIP_DVD_DATABASE_PATH === undefined
        ? null
        : dirname(process.env.RIP_DVD_DATABASE_PATH.trim())
  );
  if (requested === null || requested.length === 0 || !isAbsolute(requested)) {
    throw new Error("Archive ownership authority is unavailable");
  }
  const authorityRoot = realpathSync(requested);
  const metadata = lstatSync(authorityRoot);
  const effectiveUserId = process.geteuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    effectiveUserId === undefined ||
    metadata.uid !== effectiveUserId
  ) {
    throw new Error("Archive ownership authority is unsafe");
  }
  return authorityRoot;
}

async function pathsFor(
  originalsLibraryPath: string,
  archiveId: string,
  imagePath: string | null,
  create: boolean,
  authorityRootPath: string | undefined,
  inspectStorage: (path: string) => LinuxStorageInspection,
): Promise<OwnershipPaths | null> {
  let root: string;
  try {
    root = await realpath(originalsLibraryPath);
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error("Originals Library root is unsafe");
    }
    const authorityRoot = configuredAuthorityRoot(root, authorityRootPath);
    if (!ownershipStoragePathsAreSupported(
      root,
      authorityRoot,
      imagePath,
      inspectStorage,
    )) {
      throw new Error("Archive image storage is unsupported");
    }
    const directory = join(authorityRoot, ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME);
    let directoryCreated = false;
    try {
      if (create) {
        directoryCreated = (await mkdir(directory, {
          recursive: true,
          mode: 0o700,
        })) !== undefined;
      } else {
        try {
          await lstat(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      }
      validateDirectory(directory);
      if (await realpath(directory) !== directory) {
        throw new Error("Ownership directory changed");
      }
    } catch (cause) {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause });
    }
    const stem = ownershipStem(archiveId);
    return {
      root,
      authorityRoot,
      directory,
      directoryCreated,
      namespaceIdentity: join(
        authorityRoot,
        OWNERSHIP_NAMESPACE_IDENTITY_NAME,
      ),
      lock: join(directory, `${stem}.lock`),
      identity: join(directory, `${stem}.identity.json`),
      claim: join(directory, `${stem}.claim.json`),
    };
  } catch (cause) {
    if (cause instanceof ArchiveImageOwnershipError) throw cause;
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause });
  }
}

function pathsForSync(
  originalsLibraryPath: string,
  archiveId: string,
  imagePath: string,
  authorityRootPath: string | undefined,
  inspectStorage: (path: string) => LinuxStorageInspection,
): OwnershipPaths | null {
  try {
    const root = realpathSync(originalsLibraryPath);
    const rootMetadata = lstatSync(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error("Originals Library root is unsafe");
    }
    const authorityRoot = configuredAuthorityRoot(root, authorityRootPath);
    if (!ownershipStoragePathsAreSupported(
      root,
      authorityRoot,
      imagePath,
      inspectStorage,
    )) {
      throw new Error("Archive image storage is unsupported");
    }
    const directory = join(authorityRoot, ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME);
    const namespaceIdentity = join(
      authorityRoot,
      OWNERSHIP_NAMESPACE_IDENTITY_NAME,
    );
    try {
      validateDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (readNamespaceIdentitySync(namespaceIdentity) !== null) {
          throw new Error("Ownership namespace is missing");
        }
        return null;
      }
      throw error;
    }
    if (realpathSync(directory) !== directory) {
      throw new Error("Ownership directory changed");
    }
    const stem = ownershipStem(archiveId);
    return {
      root,
      authorityRoot,
      directory,
      directoryCreated: false,
      namespaceIdentity,
      lock: join(directory, `${stem}.lock`),
      identity: join(directory, `${stem}.identity.json`),
      claim: join(directory, `${stem}.claim.json`),
    };
  } catch (cause) {
    if (cause instanceof ArchiveImageOwnershipError) throw cause;
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause });
  }
}

function openLock(path: string, create: boolean): OpenedLock | null {
  let descriptor: number;
  let created = false;
  try {
    if (create) {
      try {
        descriptor = openSync(
          path,
          constants.O_RDWR |
            constants.O_NOFOLLOW |
            constants.O_CREAT |
            constants.O_EXCL,
          0o600,
        );
        created = true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        descriptor = openSync(
          path,
          constants.O_RDWR | constants.O_NOFOLLOW,
        );
      }
    } else {
      descriptor = openSync(
        path,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
    }
  } catch (cause) {
    if (!create && (cause as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause });
  }
  try {
    const opened = fstatSync(descriptor);
    const linked = lstatSync(path);
    const effectiveUserId = process.geteuid?.();
    if (
      !opened.isFile() ||
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino ||
      opened.nlink !== 1 ||
      (opened.mode & 0o077) !== 0 ||
      effectiveUserId === undefined ||
      opened.uid !== effectiveUserId
    ) {
      throw new Error("Ownership lock is unsafe");
    }
    return { descriptor, created };
  } catch (cause) {
    closeSync(descriptor);
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause });
  }
}

function assertLockIdentity(descriptor: number, path: string): LockIdentity {
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const linked = lstatSync(path, { bigint: true });
    if (
      !opened.isFile() ||
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino ||
      opened.nlink !== 1n
    ) {
      throw new Error("Ownership lock changed");
    }
    return {
      lockDevice: opened.dev.toString(),
      lockInode: opened.ino.toString(),
    };
  } catch (cause) {
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause });
  }
}

function sameLockIdentity(
  left: LockIdentity,
  right: LockIdentity,
): boolean {
  return left.lockDevice === right.lockDevice &&
    left.lockInode === right.lockInode;
}

function createNodeLockBackend(
  acquisitionTimeoutMs = ACQUISITION_TIMEOUT_MS,
): LockBackend {
  return {
    supported: true,
    acquire(descriptor, _lockPath, mode, signal) {
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const child = spawn(
          "flock",
          [
            mode === "shared" ? "--shared" : "--exclusive",
            "--nonblock",
            "--conflict-exit-code",
            String(FLOCK_CONFLICT_EXIT_CODE),
            "3",
          ],
          { shell: false, stdio: ["ignore", "ignore", "ignore", descriptor] },
        );
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          if (error === undefined) resolve(() => undefined);
          else reject(error);
        };
        const abort = () => {
          try {
            child.kill("SIGKILL");
          } finally {
            finish(signal.reason ?? new Error("Ownership lock was cancelled"));
          }
        };
        const timeout = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } finally {
            finish(new ArchiveImageOwnershipError("CONSISTENCY_FAULT"));
          }
        }, acquisitionTimeoutMs);
        timeout.unref();
        child.once("error", (cause) =>
          finish(new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause }))
        );
        child.once("close", (code) => {
          if (code === 0) finish();
          else if (code === FLOCK_CONFLICT_EXIT_CODE) {
            finish(new ArchiveImageOwnershipError("WRITER_NOT_QUIESCENT"));
          } else {
            finish(new ArchiveImageOwnershipError("CONSISTENCY_FAULT"));
          }
        });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    assertHeld(descriptor, _lockPath, mode) {
      try {
        const evidence = readFileSync(
          `/proc/self/fdinfo/${descriptor}`,
          "utf8",
        );
        const heldModes = [...evidence.matchAll(
          /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+(READ|WRITE)\b/gm,
        )].map((match) => match[1]);
        const expected = mode === "exclusive" ? "WRITE" : "READ";
        if (heldModes.length !== 1 || heldModes[0] !== expected) {
          throw new Error("Descriptor does not hold the expected flock");
        }
      } catch (cause) {
        throw cause instanceof ArchiveImageOwnershipError
          ? cause
          : new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause });
      }
    },
    inspect(descriptor) {
      const result = spawnSync(
        "flock",
        [
          "--shared",
          "--nonblock",
          "--conflict-exit-code",
          String(FLOCK_CONFLICT_EXIT_CODE),
          "3",
        ],
        {
          shell: false,
          stdio: ["ignore", "ignore", "ignore", descriptor],
          timeout: ACQUISITION_TIMEOUT_MS,
        },
      );
      if (result.status === 0) return "inactive";
      if (result.status === FLOCK_CONFLICT_EXIT_CODE) return "active";
      return "uncertain";
    },
  };
}

const inProcessLocks = new Map<
  string,
  { readers: number; writer: boolean }
>();

function createInProcessLockBackend(): LockBackend {
  return {
    supported: true,
    async acquire(_descriptor, lockPath, mode, signal) {
      signal.throwIfAborted();
      const current = inProcessLocks.get(lockPath) ?? {
        readers: 0,
        writer: false,
      };
      if (
        current.writer ||
        (mode === "exclusive" && current.readers > 0)
      ) {
        throw new ArchiveImageOwnershipError("WRITER_NOT_QUIESCENT");
      }
      if (mode === "exclusive") current.writer = true;
      else current.readers += 1;
      inProcessLocks.set(lockPath, current);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const owned = inProcessLocks.get(lockPath);
        if (owned === undefined) return;
        if (mode === "exclusive") owned.writer = false;
        else owned.readers -= 1;
        if (!owned.writer && owned.readers === 0) inProcessLocks.delete(lockPath);
      };
    },
    assertHeld(_descriptor, lockPath, mode) {
      const current = inProcessLocks.get(lockPath);
      if (
        current === undefined ||
        (mode === "exclusive" ? !current.writer : current.readers < 1)
      ) {
        throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
      }
    },
    inspect(_descriptor, lockPath) {
      return inProcessLocks.get(lockPath)?.writer ? "active" : "inactive";
    },
  };
}

function createUnsupportedLockBackend(): LockBackend {
  return {
    supported: false,
    async acquire() {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
    },
    assertHeld() {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
    },
    inspect() {
      return "uncertain";
    },
  };
}

function isClaimRecord(
  value: unknown,
  archiveId: string,
): value is WriterClaimRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") ===
      "archiveId,claimId,claimedAt,heartbeatAt,leaseExpiresAt,lockDevice,lockInode,version" &&
    record.version === ARCHIVE_IMAGE_OWNERSHIP_VERSION &&
    record.archiveId === archiveId &&
    typeof record.claimId === "string" &&
    /^[0-9a-f-]{36}$/.test(record.claimId) &&
    typeof record.claimedAt === "string" &&
    typeof record.heartbeatAt === "string" &&
    typeof record.leaseExpiresAt === "string" &&
    typeof record.lockDevice === "string" &&
    /^\d+$/.test(record.lockDevice) &&
    typeof record.lockInode === "string" &&
    /^\d+$/.test(record.lockInode) &&
    Number.isFinite(Date.parse(record.claimedAt)) &&
    Number.isFinite(Date.parse(record.heartbeatAt)) &&
    Number.isFinite(Date.parse(record.leaseExpiresAt))
  );
}

function isLockIdentityRecord(
  value: unknown,
  archiveId: string,
): value is LockIdentityRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") ===
      "archiveId,lockDevice,lockInode,version" &&
    record.version === ARCHIVE_IMAGE_OWNERSHIP_VERSION &&
    record.archiveId === archiveId &&
    typeof record.lockDevice === "string" &&
    /^\d+$/.test(record.lockDevice) &&
    typeof record.lockInode === "string" &&
    /^\d+$/.test(record.lockInode)
  );
}

function isNamespaceIdentityRecord(
  value: unknown,
): value is NamespaceIdentityRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") ===
      "directoryDevice,directoryInode,originalsRootDevice,originalsRootInode,version" &&
    record.version === ARCHIVE_IMAGE_OWNERSHIP_VERSION &&
    typeof record.originalsRootDevice === "string" &&
    /^\d+$/.test(record.originalsRootDevice) &&
    typeof record.originalsRootInode === "string" &&
    /^\d+$/.test(record.originalsRootInode) &&
    typeof record.directoryDevice === "string" &&
    /^\d+$/.test(record.directoryDevice) &&
    typeof record.directoryInode === "string" &&
    /^\d+$/.test(record.directoryInode)
  );
}

function readPrivateJsonSync(path: string): unknown | null | "invalid" {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : "invalid";
  }
  try {
    const opened = fstatSync(descriptor);
    const linked = lstatSync(path);
    const effectiveUserId = process.geteuid?.();
    if (
      !opened.isFile() ||
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino ||
      opened.nlink !== 1 ||
      (opened.mode & 0o077) !== 0 ||
      effectiveUserId === undefined ||
      opened.uid !== effectiveUserId
    ) {
      return "invalid";
    }
    return JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
  } catch {
    return "invalid";
  } finally {
    closeSync(descriptor);
  }
}

function readClaimSync(
  path: string,
  archiveId: string,
): WriterClaimRecord | null | "invalid" {
  const value = readPrivateJsonSync(path);
  if (value === null || value === "invalid") return value;
  return isClaimRecord(value, archiveId) ? value : "invalid";
}

function readLockIdentitySync(
  path: string,
  archiveId: string,
): LockIdentityRecord | null | "invalid" {
  const value = readPrivateJsonSync(path);
  if (value === null || value === "invalid") return value;
  return isLockIdentityRecord(value, archiveId) ? value : "invalid";
}

function readNamespaceIdentitySync(
  path: string,
): NamespaceIdentityRecord | null | "invalid" {
  const value = readPrivateJsonSync(path);
  if (value === null || value === "invalid") return value;
  return isNamespaceIdentityRecord(value) ? value : "invalid";
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeRecord(
  path: string,
  record: WriterClaimRecord | LockIdentityRecord | NamespaceIdentityRecord,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function currentNamespaceIdentity(paths: OwnershipPaths): NamespaceIdentityRecord {
  const originalsRoot = lstatSync(paths.root, { bigint: true });
  const directory = lstatSync(paths.directory, { bigint: true });
  if (
    !originalsRoot.isDirectory() ||
    originalsRoot.isSymbolicLink() ||
    !directory.isDirectory() ||
    directory.isSymbolicLink()
  ) {
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
  }
  return {
    version: ARCHIVE_IMAGE_OWNERSHIP_VERSION,
    originalsRootDevice: originalsRoot.dev.toString(),
    originalsRootInode: originalsRoot.ino.toString(),
    directoryDevice: directory.dev.toString(),
    directoryInode: directory.ino.toString(),
  };
}

function sameNamespaceIdentity(
  left: NamespaceIdentityRecord,
  right: NamespaceIdentityRecord,
): boolean {
  return left.originalsRootDevice === right.originalsRootDevice &&
    left.originalsRootInode === right.originalsRootInode &&
    left.directoryDevice === right.directoryDevice &&
    left.directoryInode === right.directoryInode;
}

function assertNamespaceIdentity(paths: OwnershipPaths): void {
  const recorded = readNamespaceIdentitySync(paths.namespaceIdentity);
  const current = currentNamespaceIdentity(paths);
  if (
    recorded === null ||
    recorded === "invalid" ||
    !sameNamespaceIdentity(recorded, current)
  ) {
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
  }
}

async function establishNamespaceIdentity(paths: OwnershipPaths): Promise<void> {
  const existing = readNamespaceIdentitySync(paths.namespaceIdentity);
  const current = currentNamespaceIdentity(paths);
  if (paths.directoryCreated) {
    if (existing !== null) {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
    }
    await writeRecord(paths.namespaceIdentity, current);
  }
  const established = paths.directoryCreated
    ? readNamespaceIdentitySync(paths.namespaceIdentity)
    : existing;
  if (
    established === null ||
    established === "invalid" ||
    !sameNamespaceIdentity(established, current)
  ) {
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
  }
}

async function establishLockIdentity(
  paths: OwnershipPaths,
  opened: OpenedLock,
  archiveId: string,
  lockIdentity: LockIdentity,
): Promise<void> {
  const existing = readLockIdentitySync(paths.identity, archiveId);
  if (opened.created) {
    if (existing !== null) {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
    }
    await writeRecord(paths.identity, {
      version: ARCHIVE_IMAGE_OWNERSHIP_VERSION,
      archiveId,
      ...lockIdentity,
    });
  }
  const established = opened.created
    ? readLockIdentitySync(paths.identity, archiveId)
    : existing;
  if (
    established === null ||
    established === "invalid" ||
    !sameLockIdentity(established, lockIdentity)
  ) {
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
  }
}

function createClaim(
  archiveId: string,
  claimId: string,
  claimedAt: Date,
  heartbeatAt: Date,
  leaseDurationMs: number,
  lockIdentity: LockIdentity,
): WriterClaimRecord {
  return {
    version: ARCHIVE_IMAGE_OWNERSHIP_VERSION,
    archiveId,
    claimId,
    claimedAt: claimedAt.toISOString(),
    heartbeatAt: heartbeatAt.toISOString(),
    leaseExpiresAt: new Date(
      heartbeatAt.getTime() + leaseDurationMs,
    ).toISOString(),
    ...lockIdentity,
  };
}

function consistencyFaultInspection(): ArchiveImageOwnershipInspection {
  return {
    contractVersion: ARCHIVE_IMAGE_OWNERSHIP_VERSION,
    writer: { state: "uncertain" },
    workerClaim: {
      state: "invalid",
      claimedAt: null,
      leaseExpiresAt: null,
    },
    stableRead: {
      available: false,
      blockingReasons: [{
        code: "CONSISTENCY_FAULT",
        message: reasonMessage("CONSISTENCY_FAULT"),
      }],
    },
  };
}

export function createArchiveImageOwnership({
  acquisitionTimeoutMs = ACQUISITION_TIMEOUT_MS,
  authorityRootPath,
  claimLeaseDurationMs = CLAIM_LEASE_DURATION_MS,
  ownershipCheckIntervalMs = OWNERSHIP_CHECK_INTERVAL_MS,
  now = () => new Date(),
  backend = process.platform === "linux"
    ? createNodeLockBackend(acquisitionTimeoutMs)
    : process.env.NODE_ENV === "test"
      ? createInProcessLockBackend()
      : createUnsupportedLockBackend(),
  inspectStorage = process.platform === "linux"
    ? inspectLinuxStorage
    : () => ({
      filesystemType: process.env.NODE_ENV === "test"
        ? "test-in-process"
        : "unsupported-platform",
      storageClass: process.env.NODE_ENV === "test" ? "local" : "unknown",
    }),
}: CreateOwnershipOptions = {}): ArchiveImageOwnership {
  if (
    !Number.isSafeInteger(acquisitionTimeoutMs) ||
    acquisitionTimeoutMs <= 0 ||
    !Number.isSafeInteger(claimLeaseDurationMs) ||
    claimLeaseDurationMs <= 0 ||
    !Number.isSafeInteger(ownershipCheckIntervalMs) ||
    ownershipCheckIntervalMs <= 0
  ) {
    throw new TypeError("Archive image ownership timing is invalid");
  }

  const withLock = async <Result>(
    request: OwnershipRequest<Result>,
    mode: "shared" | "exclusive",
  ): Promise<Result> => {
    request.signal.throwIfAborted();
    const paths = await pathsFor(
      request.originalsLibraryPath,
      request.archiveId,
      request.imagePath,
      true,
      authorityRootPath,
      inspectStorage,
    );
    if (paths === null) {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
    }
    const opened = openLock(paths.lock, true);
    if (opened === null) {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
    }
    const { descriptor } = opened;
    let releaseBackend: () => void = () => undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let monitor: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let heartbeatWrite = Promise.resolve();
    let claim: WriterClaimRecord | undefined;
    let retainClaim = false;
    let lockIdentity: LockIdentity | undefined;
    const failOwnership = (cause: unknown): ArchiveImageOwnershipError => {
      retainClaim = true;
      const error = cause instanceof ArchiveImageOwnershipError
        ? cause
        : new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause });
      if (!controller.signal.aborted) controller.abort(error);
      return error;
    };
    try {
      await establishNamespaceIdentity(paths);
      lockIdentity = assertLockIdentity(descriptor, paths.lock);
      await establishLockIdentity(
        paths,
        opened,
        request.archiveId,
        lockIdentity,
      );
      releaseBackend = await backend.acquire(
        descriptor,
        paths.lock,
        mode,
        request.signal,
      );
      try {
        const acquiredIdentity = assertLockIdentity(descriptor, paths.lock);
        if (
          !sameLockIdentity(acquiredIdentity, lockIdentity) ||
          !ownershipStoragePathsAreSupported(
            paths.root,
            paths.authorityRoot,
            request.imagePath,
            inspectStorage,
          )
        ) {
          throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
        }
      } catch (cause) {
        throw failOwnership(cause);
      }
      backend.assertHeld(descriptor, paths.lock, mode);
      const existingClaim = readClaimSync(paths.claim, request.archiveId);
      if (
        existingClaim === "invalid" ||
        (existingClaim !== null &&
          (!sameLockIdentity(existingClaim, lockIdentity) ||
            Date.parse(existingClaim.leaseExpiresAt) > now().getTime()))
      ) {
        throw failOwnership(new ArchiveImageOwnershipError(
          "CONSISTENCY_FAULT",
        ));
      }
      if (mode === "exclusive") {
        const claimedAt = now();
        claim = createClaim(
          request.archiveId,
          randomUUID(),
          claimedAt,
          claimedAt,
          claimLeaseDurationMs,
          lockIdentity,
        );
        try {
          await writeRecord(paths.claim, claim);
        } catch (cause) {
          throw failOwnership(cause);
        }
        heartbeat = setInterval(() => {
          const currentClaim = claim;
          if (currentClaim === undefined || controller.signal.aborted) return;
          const heartbeatAt = now();
          claim = createClaim(
            request.archiveId,
            currentClaim.claimId,
            new Date(currentClaim.claimedAt),
            heartbeatAt,
            claimLeaseDurationMs,
            currentClaim,
          );
          const nextClaim = claim;
          heartbeatWrite = heartbeatWrite
            .then(() => writeRecord(paths.claim, nextClaim))
            .catch((cause) => {
              failOwnership(cause);
            });
        }, Math.max(1, Math.floor(claimLeaseDurationMs / 3)));
        heartbeat.unref();
      }
      const assertOwned = () => {
        try {
          const currentIdentity = assertLockIdentity(descriptor, paths.lock);
          if (!ownershipStoragePathsAreSupported(
            paths.root,
            paths.authorityRoot,
            request.imagePath,
            inspectStorage,
          )) {
            throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
          }
          assertNamespaceIdentity(paths);
          backend.assertHeld(descriptor, paths.lock, mode);
          const establishedIdentity = readLockIdentitySync(
            paths.identity,
            request.archiveId,
          );
          if (
            lockIdentity === undefined ||
            !sameLockIdentity(currentIdentity, lockIdentity) ||
            establishedIdentity === null ||
            establishedIdentity === "invalid" ||
            !sameLockIdentity(establishedIdentity, lockIdentity)
          ) {
            throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
          }
        } catch (cause) {
          throw failOwnership(cause);
        }
      };
      monitor = setInterval(() => {
        try {
          assertOwned();
        } catch (error) {
          controller.abort(error);
        }
      }, ownershipCheckIntervalMs);
      monitor.unref();
      const result = await request.task({ descriptor, signal, assertOwned });
      signal.throwIfAborted();
      assertOwned();
      return result;
    } catch (cause) {
      if (cause instanceof ArchiveImageOwnershipError) throw cause;
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof ArchiveImageOwnershipError
          ? controller.signal.reason
          : new ArchiveImageOwnershipError("CONSISTENCY_FAULT", {
              cause: controller.signal.reason,
            });
      }
      throw cause;
    } finally {
      if (monitor !== undefined) clearInterval(monitor);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      await heartbeatWrite;
      if (claim !== undefined && !retainClaim) {
        try {
          const current = readClaimSync(paths.claim, request.archiveId);
          if (current !== "invalid" && current?.claimId === claim.claimId) {
            await unlink(paths.claim);
            await syncDirectory(paths.directory);
          }
        } catch {
          // A retained claim is conservative. Inspection reports it rather
          // than erasing evidence after uncertain cleanup.
        }
      }
      releaseBackend();
      closeSync(descriptor);
    }
  };

  return {
    inspect({ archiveId, imagePath, originalsLibraryPath }) {
      if (!backend.supported) {
        return consistencyFaultInspection();
      }
      let paths: OwnershipPaths | null;
      try {
        paths = pathsForSync(
          originalsLibraryPath,
          archiveId,
          imagePath,
          authorityRootPath,
          inspectStorage,
        );
      } catch {
        return consistencyFaultInspection();
      }
      if (paths === null) {
        return {
          contractVersion: ARCHIVE_IMAGE_OWNERSHIP_VERSION,
          writer: { state: "inactive" },
          workerClaim: {
            state: "none",
            claimedAt: null,
            leaseExpiresAt: null,
          },
          stableRead: { available: true, blockingReasons: [] },
        };
      }
      let descriptor: number | null = null;
      try {
        assertNamespaceIdentity(paths);
        const opened = openLock(paths.lock, false);
        descriptor = opened?.descriptor ?? null;
        const identity = readLockIdentitySync(paths.identity, archiveId);
        const claim = readClaimSync(paths.claim, archiveId);
        if (descriptor === null) {
          if (identity !== null || claim !== null) {
            return consistencyFaultInspection();
          }
          return {
            contractVersion: ARCHIVE_IMAGE_OWNERSHIP_VERSION,
            writer: { state: "inactive" },
            workerClaim: {
              state: "none",
              claimedAt: null,
              leaseExpiresAt: null,
            },
            stableRead: { available: true, blockingReasons: [] },
          };
        }
        const lockIdentity = assertLockIdentity(descriptor, paths.lock);
        const identityFault =
          identity === null ||
          identity === "invalid" ||
          !sameLockIdentity(identity, lockIdentity);
        let writerState: ArchiveImageOwnershipInspection["writer"]["state"] =
          identityFault ? "uncertain" : backend.inspect(descriptor, paths.lock);
        if (
          claim !== null &&
          claim !== "invalid" &&
          !sameLockIdentity(claim, lockIdentity)
        ) {
          writerState = "uncertain";
        }
        const workerClaim: ArchiveImageOwnershipInspection["workerClaim"] =
          claim === "invalid"
            ? { state: "invalid", claimedAt: null, leaseExpiresAt: null }
            : claim === null
              ? { state: "none", claimedAt: null, leaseExpiresAt: null }
              : {
                  state: Date.parse(claim.leaseExpiresAt) > now().getTime()
                    ? "active"
                    : "expired",
                  claimedAt: claim.claimedAt,
                  leaseExpiresAt: claim.leaseExpiresAt,
                };
        const code: ArchiveImageOwnershipReasonCode | null =
          writerState === "active"
            ? "WRITER_NOT_QUIESCENT"
            : writerState === "uncertain" ||
                workerClaim.state === "invalid" ||
                workerClaim.state === "active"
              ? "CONSISTENCY_FAULT"
              : null;
        return {
          contractVersion: ARCHIVE_IMAGE_OWNERSHIP_VERSION,
          writer: { state: writerState },
          workerClaim,
          stableRead: code === null
            ? { available: true, blockingReasons: [] }
            : {
                available: false,
                blockingReasons: [{ code, message: reasonMessage(code) }],
              },
        };
      } catch {
        return consistencyFaultInspection();
      } finally {
        if (descriptor !== null) closeSync(descriptor);
      }
    },
    withConsistentRead: (request) => withLock(request, "shared"),
    withWriter: (request) => withLock(request, "exclusive"),
  };
}

export const defaultArchiveImageOwnership = createArchiveImageOwnership();
