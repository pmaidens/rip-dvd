import { assertKernelFlock } from "./kernel-process-lock.js";
import { enterArchiveImageAdmission } from "./archive-image-admission.js";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeSync,
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
export const ARCHIVE_IMAGE_OWNERSHIP_NAMESPACE_IDENTITY_NAME =
  ".rip-dvd-archive-ownership.identity.json";
const ARCHIVE_IMAGE_OWNERSHIP_REGISTRY_NAME =
  ".rip-dvd-archive-ownership.registry";
const ORIGINALS_NAMESPACE_IDENTITY_NAME =
  ".rip-dvd-archive-ownership.authority.json";
const ORIGINALS_ARCHIVE_IDENTITY_PREFIX =
  ".rip-dvd-archive-ownership.archive-";

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
  previewRead?: { onContention(urgent: boolean, waiting: boolean): void };
  urgent?: boolean;
  archiveId: string;
  additionalImagePaths?: readonly string[];
  imagePath: string | null;
  originalsLibraryPath: string;
  signal: AbortSignal;
  task(handle: ArchiveImageOwnershipHandle): Promise<Result>;
  commit?: (
    prepared: Result,
    handle: ArchiveImageOwnershipHandle,
  ) => Result;
}

export interface ArchiveImageOwnership {
  inspect(input: {
    archiveId: string;
    imagePath: string;
    originalsLibraryPath: string;
  }): ArchiveImageOwnershipInspection;
  withInitialPublicationWriter<Result>(
    request: OwnershipRequest<Result>,
  ): Promise<Result>;
  withConsistentRead<Result>(
    request: OwnershipRequest<Result>,
  ): Promise<Result>;
  withWriter<Result>(
    request: OwnershipRequest<Result>,
  ): Promise<Result>;
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
  authorityRootDevice: string;
  authorityRootInode: string;
  originalsRootDevice: string;
  originalsRootInode: string;
  directoryDevice: string;
  directoryInode: string;
  registryDevice: string;
  registryInode: string;
}

interface OwnershipPaths {
  root: string;
  authorityRoot: string;
  directory: string;
  directoryCreated: boolean;
  namespaceIdentity: string;
  originalsNamespaceIdentity: string;
  registry: string;
  archiveIdentity: string;
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
  writeHeartbeatRecord?: (
    path: string,
    record: WriterClaimRecord,
  ) => Promise<void>;
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
  additionalImagePaths: readonly string[] = [],
  ownershipPaths: readonly string[] = [],
): boolean {
  const paths = new Set([
    root,
    authorityRoot,
    resolveStorageProbePath(root, imagePath),
    ...additionalImagePaths.map((path) => resolveStorageProbePath(root, path)),
    ...ownershipPaths.map((path) => resolveStorageProbePath(root, path)),
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
  additionalImagePaths: readonly string[],
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
      additionalImagePaths,
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
      if (!ownershipStorageIsSupported(inspectStorage(directory))) {
        throw new Error("Ownership directory storage is unsupported");
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
        ARCHIVE_IMAGE_OWNERSHIP_NAMESPACE_IDENTITY_NAME,
      ),
      originalsNamespaceIdentity: join(
        root,
        ORIGINALS_NAMESPACE_IDENTITY_NAME,
      ),
      registry: join(
        authorityRoot,
        ARCHIVE_IMAGE_OWNERSHIP_REGISTRY_NAME,
      ),
      archiveIdentity: join(
        root,
        `${ORIGINALS_ARCHIVE_IDENTITY_PREFIX}${stem}.identity.json`,
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
    const stem = ownershipStem(archiveId);
    const directory = join(authorityRoot, ARCHIVE_IMAGE_OWNERSHIP_DIRECTORY_NAME);
    const namespaceIdentity = join(
      authorityRoot,
      ARCHIVE_IMAGE_OWNERSHIP_NAMESPACE_IDENTITY_NAME,
    );
    const originalsNamespaceIdentity = join(
      root,
      ORIGINALS_NAMESPACE_IDENTITY_NAME,
    );
    const registry = join(
      authorityRoot,
      ARCHIVE_IMAGE_OWNERSHIP_REGISTRY_NAME,
    );
    const archiveIdentity = join(
      root,
      `${ORIGINALS_ARCHIVE_IDENTITY_PREFIX}${stem}.identity.json`,
    );
    try {
      validateDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (
          readNamespaceIdentitySync(namespaceIdentity) !== null ||
          readNamespaceIdentitySync(originalsNamespaceIdentity) !== null ||
          readArchiveRegistrySync(registry) !== null ||
          readLockIdentitySync(archiveIdentity, archiveId) !== null
        ) {
          throw new Error("Ownership namespace is missing");
        }
        return null;
      }
      throw error;
    }
    if (realpathSync(directory) !== directory) {
      throw new Error("Ownership directory changed");
    }
    if (!ownershipStorageIsSupported(inspectStorage(directory))) {
      throw new Error("Ownership directory storage is unsupported");
    }
    return {
      root,
      authorityRoot,
      directory,
      directoryCreated: false,
      namespaceIdentity,
      originalsNamespaceIdentity,
      registry,
      archiveIdentity,
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

function readArchiveRegistryDescriptorSync(
  descriptor: number,
): Set<string> | "invalid" {
  try {
    const metadata = fstatSync(descriptor);
    if (metadata.size > 16 * 1024 * 1024) return "invalid";
    const contents = Buffer.alloc(metadata.size);
    if (
      metadata.size > 0 &&
      readSync(descriptor, contents, 0, metadata.size, 0) !== metadata.size
    ) {
      return "invalid";
    }
    const text = contents.toString("utf8");
    if (text.length === 0) return new Set();
    if (!text.endsWith("\n")) return "invalid";
    const entries = text.slice(0, -1).split("\n");
    if (
      entries.some((entry) => !/^[0-9a-f]{64}$/.test(entry)) ||
      new Set(entries).size !== entries.length
    ) {
      return "invalid";
    }
    return new Set(entries);
  } catch {
    return "invalid";
  }
}

function readArchiveRegistrySync(path: string): Set<string> | null | "invalid" {
  let opened: OpenedLock | null;
  try {
    opened = openLock(path, false);
  } catch {
    return "invalid";
  }
  if (opened === null) return null;
  try {
    return readArchiveRegistryDescriptorSync(opened.descriptor);
  } finally {
    closeSync(opened.descriptor);
  }
}

async function appendArchiveRegistry(
  descriptor: number,
  path: string,
  archiveId: string,
): Promise<void> {
  const payload = Buffer.from(`${ownershipStem(archiveId)}\n`, "utf8");
  const size = fstatSync(descriptor).size;
  if (writeSync(descriptor, payload, 0, payload.length, size) !== payload.length) {
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
  }
  fsyncSync(descriptor);
  await syncDirectory(dirname(path));
}

function assertLockIdentity(descriptor: number, path: string): LockIdentity {
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const linked = lstatSync(path, { bigint: true });
    const effectiveUserId = process.geteuid?.();
    if (
      !opened.isFile() ||
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino ||
      opened.nlink !== 1n ||
      (opened.mode & 0o077n) !== 0n ||
      effectiveUserId === undefined ||
      opened.uid !== BigInt(effectiveUserId)
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
        assertKernelFlock(descriptor, mode);
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
  const claimedAt = typeof record.claimedAt === "string"
    ? Date.parse(record.claimedAt)
    : Number.NaN;
  const heartbeatAt = typeof record.heartbeatAt === "string"
    ? Date.parse(record.heartbeatAt)
    : Number.NaN;
  const leaseExpiresAt = typeof record.leaseExpiresAt === "string"
    ? Date.parse(record.leaseExpiresAt)
    : Number.NaN;
  const hasCanonicalTimestamp = (timestamp: unknown, epochMs: number) =>
    typeof timestamp === "string" &&
    Number.isFinite(epochMs) &&
    new Date(epochMs).toJSON() === timestamp;
  return (
    Object.keys(record).sort().join(",") ===
      "archiveId,claimId,claimedAt,heartbeatAt,leaseExpiresAt,lockDevice,lockInode,version" &&
    record.version === ARCHIVE_IMAGE_OWNERSHIP_VERSION &&
    record.archiveId === archiveId &&
    typeof record.claimId === "string" &&
    /^[0-9a-f-]{36}$/.test(record.claimId) &&
    hasCanonicalTimestamp(record.claimedAt, claimedAt) &&
    hasCanonicalTimestamp(record.heartbeatAt, heartbeatAt) &&
    hasCanonicalTimestamp(record.leaseExpiresAt, leaseExpiresAt) &&
    claimedAt <= heartbeatAt &&
    heartbeatAt < leaseExpiresAt &&
    typeof record.lockDevice === "string" &&
    /^\d+$/.test(record.lockDevice) &&
    typeof record.lockInode === "string" &&
    /^\d+$/.test(record.lockInode)
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
      "authorityRootDevice,authorityRootInode,directoryDevice,directoryInode,originalsRootDevice,originalsRootInode,registryDevice,registryInode,version" &&
    record.version === ARCHIVE_IMAGE_OWNERSHIP_VERSION &&
    typeof record.authorityRootDevice === "string" &&
    /^\d+$/.test(record.authorityRootDevice) &&
    typeof record.authorityRootInode === "string" &&
    /^\d+$/.test(record.authorityRootInode) &&
    typeof record.originalsRootDevice === "string" &&
    /^\d+$/.test(record.originalsRootDevice) &&
    typeof record.originalsRootInode === "string" &&
    /^\d+$/.test(record.originalsRootInode) &&
    typeof record.directoryDevice === "string" &&
    /^\d+$/.test(record.directoryDevice) &&
    typeof record.directoryInode === "string" &&
    /^\d+$/.test(record.directoryInode) &&
    typeof record.registryDevice === "string" &&
    /^\d+$/.test(record.registryDevice) &&
    typeof record.registryInode === "string" &&
    /^\d+$/.test(record.registryInode)
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

async function writeNewRecord(
  path: string,
  record: LockIdentityRecord,
): Promise<void> {
  const file = await open(
    path,
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
  await syncDirectory(dirname(path));
}

async function createEmptyPrivateFile(path: string): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}

function currentNamespaceIdentity(paths: OwnershipPaths): NamespaceIdentityRecord {
  validateDirectory(paths.directory);
  const authorityRoot = lstatSync(paths.authorityRoot, { bigint: true });
  const originalsRoot = lstatSync(paths.root, { bigint: true });
  const directory = lstatSync(paths.directory, { bigint: true });
  const registry = lstatSync(paths.registry, { bigint: true });
  const effectiveUserId = process.geteuid?.();
  if (
    !authorityRoot.isDirectory() ||
    authorityRoot.isSymbolicLink() ||
    !originalsRoot.isDirectory() ||
    originalsRoot.isSymbolicLink() ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    !registry.isFile() ||
    registry.isSymbolicLink() ||
    registry.nlink !== 1n ||
    (registry.mode & 0o077n) !== 0n ||
    effectiveUserId === undefined ||
    registry.uid !== BigInt(effectiveUserId)
  ) {
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
  }
  return {
    version: ARCHIVE_IMAGE_OWNERSHIP_VERSION,
    authorityRootDevice: authorityRoot.dev.toString(),
    authorityRootInode: authorityRoot.ino.toString(),
    originalsRootDevice: originalsRoot.dev.toString(),
    originalsRootInode: originalsRoot.ino.toString(),
    directoryDevice: directory.dev.toString(),
    directoryInode: directory.ino.toString(),
    registryDevice: registry.dev.toString(),
    registryInode: registry.ino.toString(),
  };
}

function sameNamespaceIdentity(
  left: NamespaceIdentityRecord,
  right: NamespaceIdentityRecord,
): boolean {
  return left.authorityRootDevice === right.authorityRootDevice &&
    left.authorityRootInode === right.authorityRootInode &&
    left.originalsRootDevice === right.originalsRootDevice &&
    left.originalsRootInode === right.originalsRootInode &&
    left.directoryDevice === right.directoryDevice &&
    left.directoryInode === right.directoryInode &&
    left.registryDevice === right.registryDevice &&
    left.registryInode === right.registryInode;
}

function assertNamespaceIdentity(paths: OwnershipPaths): NamespaceIdentityRecord {
  const authorityRecord = readNamespaceIdentitySync(paths.namespaceIdentity);
  const originalsRecord = readNamespaceIdentitySync(
    paths.originalsNamespaceIdentity,
  );
  const current = currentNamespaceIdentity(paths);
  if (
    authorityRecord === null ||
    authorityRecord === "invalid" ||
    originalsRecord === null ||
    originalsRecord === "invalid" ||
    !sameNamespaceIdentity(authorityRecord, originalsRecord) ||
    !sameNamespaceIdentity(authorityRecord, current)
  ) {
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
  }
  return authorityRecord;
}

async function establishNamespaceIdentity(
  paths: OwnershipPaths,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  let existingAuthority = readNamespaceIdentitySync(paths.namespaceIdentity);
  let existingOriginals = readNamespaceIdentitySync(
    paths.originalsNamespaceIdentity,
  );
  if (paths.directoryCreated) {
    if (existingAuthority !== null || existingOriginals !== null) {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
    }
    await createEmptyPrivateFile(paths.registry);
    const current = currentNamespaceIdentity(paths);
    await writeRecord(paths.namespaceIdentity, current);
    await writeRecord(paths.originalsNamespaceIdentity, current);
  } else if (existingAuthority === null && existingOriginals === null) {
    const deadline = Date.now() + timeoutMs;
    do {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      existingAuthority = readNamespaceIdentitySync(paths.namespaceIdentity);
      existingOriginals = readNamespaceIdentitySync(
        paths.originalsNamespaceIdentity,
      );
    } while (
      (existingAuthority === null || existingOriginals === null) &&
      Date.now() < deadline
    );
  }
  const current = currentNamespaceIdentity(paths);
  const establishedAuthority = paths.directoryCreated
    ? readNamespaceIdentitySync(paths.namespaceIdentity)
    : existingAuthority;
  const establishedOriginals = paths.directoryCreated
    ? readNamespaceIdentitySync(paths.originalsNamespaceIdentity)
    : existingOriginals;
  if (
    establishedAuthority === null ||
    establishedAuthority === "invalid" ||
    establishedOriginals === null ||
    establishedOriginals === "invalid" ||
    !sameNamespaceIdentity(establishedAuthority, establishedOriginals) ||
    !sameNamespaceIdentity(establishedAuthority, current)
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
  const existingArchiveIdentity = readLockIdentitySync(
    paths.archiveIdentity,
    archiveId,
  );
  if (opened.created) {
    if (existing !== null || existingArchiveIdentity !== null) {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
    }
    const record: LockIdentityRecord = {
      version: ARCHIVE_IMAGE_OWNERSHIP_VERSION,
      archiveId,
      ...lockIdentity,
    };
    await writeRecord(paths.identity, record);
    await writeNewRecord(paths.archiveIdentity, record);
  }
  const established = opened.created
    ? readLockIdentitySync(paths.identity, archiveId)
    : existing;
  const establishedArchiveIdentity = opened.created
    ? readLockIdentitySync(paths.archiveIdentity, archiveId)
    : existingArchiveIdentity;
  if (
    established === null ||
    established === "invalid" ||
    establishedArchiveIdentity === null ||
    establishedArchiveIdentity === "invalid" ||
    !sameLockIdentity(established, lockIdentity) ||
    !sameLockIdentity(establishedArchiveIdentity, lockIdentity) ||
    !sameLockIdentity(established, establishedArchiveIdentity)
  ) {
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
  }
}

function registryMatchesNamespace(
  identity: LockIdentity,
  namespace: NamespaceIdentityRecord,
): boolean {
  return identity.lockDevice === namespace.registryDevice &&
    identity.lockInode === namespace.registryInode;
}

function assertArchiveRegistered(
  paths: OwnershipPaths,
  archiveId: string,
): void {
  const namespace = assertNamespaceIdentity(paths);
  const opened = openLock(paths.registry, false);
  if (opened === null) {
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
  }
  try {
    const identity = assertLockIdentity(opened.descriptor, paths.registry);
    const entries = readArchiveRegistryDescriptorSync(opened.descriptor);
    if (
      !registryMatchesNamespace(identity, namespace) ||
      entries === "invalid" ||
      !entries.has(ownershipStem(archiveId))
    ) {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
    }
  } finally {
    closeSync(opened.descriptor);
  }
}

async function prepareArchiveLock(
  paths: OwnershipPaths,
  archiveId: string,
  initialize: boolean,
  signal: AbortSignal,
  backend: LockBackend,
  acquisitionTimeoutMs: number,
): Promise<OpenedLock> {
  const registry = openLock(paths.registry, false);
  if (registry === null) {
    throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
  }
  let releaseRegistry: () => void = () => undefined;
  let opened: OpenedLock | null = null;
  try {
    try {
      const deadline = Date.now() + acquisitionTimeoutMs;
      while (true) {
        try {
          releaseRegistry = await backend.acquire(
            registry.descriptor,
            paths.registry,
            "exclusive",
            signal,
          );
          break;
        } catch (cause) {
          if (
            !(cause instanceof ArchiveImageOwnershipError) ||
            cause.code !== "WRITER_NOT_QUIESCENT" ||
            Date.now() >= deadline
          ) {
            throw cause;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          signal.throwIfAborted();
        }
      }
    } catch (cause) {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause });
    }
    const namespace = assertNamespaceIdentity(paths);
    const registryIdentity = assertLockIdentity(
      registry.descriptor,
      paths.registry,
    );
    backend.assertHeld(registry.descriptor, paths.registry, "exclusive");
    const entries = readArchiveRegistryDescriptorSync(registry.descriptor);
    if (
      !registryMatchesNamespace(registryIdentity, namespace) ||
      entries === "invalid"
    ) {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
    }
    const stem = ownershipStem(archiveId);
    const registered = entries.has(stem);
    if (!registered) {
      if (!initialize) {
        throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
      }
      await appendArchiveRegistry(registry.descriptor, paths.registry, archiveId);
    }
    opened = openLock(paths.lock, !registered);
    if (
      opened === null ||
      (registered ? opened.created : !opened.created)
    ) {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
    }
    const lockIdentity = assertLockIdentity(opened.descriptor, paths.lock);
    await establishLockIdentity(paths, opened, archiveId, lockIdentity);
    const establishedEntries = readArchiveRegistryDescriptorSync(
      registry.descriptor,
    );
    const establishedNamespace = assertNamespaceIdentity(paths);
    const establishedRegistryIdentity = assertLockIdentity(
      registry.descriptor,
      paths.registry,
    );
    backend.assertHeld(registry.descriptor, paths.registry, "exclusive");
    if (
      establishedEntries === "invalid" ||
      !establishedEntries.has(stem) ||
      !registryMatchesNamespace(
        establishedRegistryIdentity,
        establishedNamespace,
      )
    ) {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
    }
    return opened;
  } catch (cause) {
    if (opened !== null) closeSync(opened.descriptor);
    throw cause instanceof ArchiveImageOwnershipError
      ? cause
      : new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause });
  } finally {
    releaseRegistry();
    closeSync(registry.descriptor);
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
  inspectStorage = process.env.NODE_ENV === "test"
    ? () => ({
      filesystemType: "test-in-process",
      storageClass: "local",
    })
    : process.platform === "linux"
      ? inspectLinuxStorage
      : () => ({
        filesystemType: "unsupported-platform",
        storageClass: "unknown",
      }),
  writeHeartbeatRecord = writeRecord,
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
    initialize: boolean,
  ): Promise<Result> => {
    request.signal.throwIfAborted();
    const paths = await pathsFor(
      request.originalsLibraryPath,
      request.archiveId,
      request.imagePath,
      initialize,
      authorityRootPath,
      inspectStorage,
      request.additionalImagePaths ?? [],
    );
    if (paths === null) {
      throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
    }
    try {
      if (initialize) {
        await establishNamespaceIdentity(
          paths,
          request.signal,
          acquisitionTimeoutMs,
        );
      } else {
        assertNamespaceIdentity(paths);
      }
    } catch (cause) {
      throw cause instanceof ArchiveImageOwnershipError
        ? cause
        : new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause });
    }
    // Preview readers take an exclusive image interval so every ordinary
    // reader and writer participates in contention, including surviving children.
    if (request.previewRead) mode = "exclusive";
    const admission = process.platform === "linux" ? await enterArchiveImageAdmission({
      directory: `${paths.lock}.admission`, preview: request.previewRead !== undefined,
      urgent: request.urgent === true, signal: request.signal,
      ...(request.previewRead ? { onContention: request.previewRead.onContention } : {}),
    }) : null;
    let opened;
    try { opened = await prepareArchiveLock(
      paths,
      request.archiveId,
      initialize,
      request.signal,
      backend,
      acquisitionTimeoutMs,
    );
    } catch (error) { await admission?.release(); throw error; }
    const { descriptor } = opened;
    let releaseBackend: () => void = () => undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let monitor: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let heartbeatWrite = Promise.resolve();
    let heartbeatFailure: ArchiveImageOwnershipError | undefined;
    let claim: WriterClaimRecord | undefined;
    let retainClaim = false;
    let lockIdentity: LockIdentity | undefined;
    let assertOwned: (() => void) | undefined;
    const failOwnership = (cause: unknown): ArchiveImageOwnershipError => {
      retainClaim = true;
      const error = cause instanceof ArchiveImageOwnershipError
        ? cause
        : new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause });
      if (!controller.signal.aborted) controller.abort(error);
      return error;
    };
    const stopHeartbeat = async () => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      await heartbeatWrite;
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
    };
    try {
      let storageSupported: boolean;
      try {
        storageSupported = ownershipStoragePathsAreSupported(
          paths.root,
          paths.authorityRoot,
          request.imagePath,
          inspectStorage,
          request.additionalImagePaths,
          [paths.directory, paths.registry, paths.lock, paths.archiveIdentity],
        );
      } catch (cause) {
        throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT", { cause });
      }
      if (!storageSupported) {
        throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
      }
      lockIdentity = assertLockIdentity(descriptor, paths.lock);
      releaseBackend = await backend.acquire(
        descriptor,
        paths.lock,
        mode,
        request.signal,
      );
      const assertCurrentOwnership = () => {
        try {
          const currentIdentity = assertLockIdentity(descriptor, paths.lock);
          if (!ownershipStoragePathsAreSupported(
            paths.root,
            paths.authorityRoot,
            request.imagePath,
            inspectStorage,
            request.additionalImagePaths,
            [
              paths.directory,
              paths.registry,
              paths.lock,
              paths.archiveIdentity,
            ],
          )) {
            throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
          }
          assertArchiveRegistered(paths, request.archiveId);
          backend.assertHeld(descriptor, paths.lock, mode);
          const establishedIdentity = readLockIdentitySync(
            paths.identity,
            request.archiveId,
          );
          const establishedArchiveIdentity = readLockIdentitySync(
            paths.archiveIdentity,
            request.archiveId,
          );
          if (
            lockIdentity === undefined ||
            !sameLockIdentity(currentIdentity, lockIdentity) ||
            establishedIdentity === null ||
            establishedIdentity === "invalid" ||
            establishedArchiveIdentity === null ||
            establishedArchiveIdentity === "invalid" ||
            !sameLockIdentity(establishedIdentity, lockIdentity) ||
            !sameLockIdentity(establishedArchiveIdentity, lockIdentity) ||
            !sameLockIdentity(establishedIdentity, establishedArchiveIdentity)
          ) {
            throw new ArchiveImageOwnershipError("CONSISTENCY_FAULT");
          }
        } catch (cause) {
          throw failOwnership(cause);
        }
      };
      assertOwned = assertCurrentOwnership;
      assertCurrentOwnership();
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
      if (mode === "exclusive" && request.previewRead === undefined) {
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
            .then(() => writeHeartbeatRecord(paths.claim, nextClaim))
            .catch((cause) => {
              heartbeatFailure = failOwnership(cause);
            });
        }, Math.max(1, Math.floor(claimLeaseDurationMs / 3)));
        heartbeat.unref();
      }
      assertCurrentOwnership();
      monitor = setInterval(() => {
        try {
          assertCurrentOwnership();
        } catch (error) {
          controller.abort(error);
        }
      }, ownershipCheckIntervalMs);
      monitor.unref();
      const handle = {
        descriptor,
        signal,
        assertOwned: assertCurrentOwnership,
      };
      const prepared = await request.task(handle);
      await stopHeartbeat();
      signal.throwIfAborted();
      assertCurrentOwnership();
      return request.commit === undefined
        ? prepared
        : request.commit(prepared, handle);
    } catch (caught) {
      let cause = caught;
      try {
        await stopHeartbeat();
      } catch (heartbeatCause) {
        cause = heartbeatCause;
      }
      if (assertOwned !== undefined) {
        try {
          assertOwned();
        } catch (ownershipCause) {
          throw ownershipCause;
        }
      }
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
      await admission?.release();
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
        return consistencyFaultInspection();
      }
      let descriptor: number | null = null;
      try {
        assertArchiveRegistered(paths, archiveId);
        const opened = openLock(paths.lock, false);
        descriptor = opened?.descriptor ?? null;
        const identity = readLockIdentitySync(paths.identity, archiveId);
        const archiveIdentity = readLockIdentitySync(
          paths.archiveIdentity,
          archiveId,
        );
        const claim = readClaimSync(paths.claim, archiveId);
        if (descriptor === null) {
          return consistencyFaultInspection();
        }
        if (!ownershipStoragePathsAreSupported(
          paths.root,
          paths.authorityRoot,
          imagePath,
          inspectStorage,
          [],
          [paths.directory, paths.registry, paths.lock, paths.archiveIdentity],
        )) {
          return consistencyFaultInspection();
        }
        const lockIdentity = assertLockIdentity(descriptor, paths.lock);
        const identityFault =
          identity === null ||
          identity === "invalid" ||
          archiveIdentity === null ||
          archiveIdentity === "invalid" ||
          !sameLockIdentity(identity, lockIdentity) ||
          !sameLockIdentity(archiveIdentity, lockIdentity) ||
          !sameLockIdentity(identity, archiveIdentity);
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
          writerState === "uncertain" || workerClaim.state === "invalid"
              ? "CONSISTENCY_FAULT"
            : writerState === "active"
              ? "WRITER_NOT_QUIESCENT"
              : workerClaim.state === "active"
                ? "CONSISTENCY_FAULT"
              : null;
        const finalLockIdentity = assertLockIdentity(descriptor, paths.lock);
        assertArchiveRegistered(paths, archiveId);
        if (!sameLockIdentity(finalLockIdentity, lockIdentity)) {
          return consistencyFaultInspection();
        }
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
    withInitialPublicationWriter: (request) =>
      withLock(request, "exclusive", true),
    withConsistentRead: (request) => withLock(request, "shared", false),
    withWriter: (request) => withLock(request, "exclusive", false),
  };
}

export const defaultArchiveImageOwnership = createArchiveImageOwnership();
