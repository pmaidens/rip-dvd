import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  canonicalPublicationJson,
  createDvdArchiveEvidenceManifestDigests,
  createDvdArchiveRecoveryReadEvidenceDigest,
  createDvdRecoveryCheckpointPublicationDigest,
  dvdConfirmedRecoveryWriteAuthority,
  dvdDiscVerificationInsertionIsCurrent,
  dvdEvidenceRangesAfterRecoveryRead,
  DVD_RECOVERY_ATOMIC_WRITE_CONTRACT,
  DVD_RECOVERY_JOURNAL_METADATA_BYTES,
  DVD_RECOVERY_JOURNAL_PAYLOAD_BYTES,
  DVD_RECOVERY_JOURNAL_RESERVATION_BYTES,
  DVD_RECOVERY_MAX_CHECKPOINT_REVISION,
  DvdCheckpointReadFault,
  readCommittedDvdCheckpoint,
  type CommittedDvdCheckpointEvidence,
  type CommittedDvdRecoveryEvidence,
  type ClaimedArchiveRecoveryWork,
  type DataAccess,
  type DvdArchiveEvidenceHeader,
  type DvdRecoveryProtectedRange,
  type DvdRecoveryWriteAuthority,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
  type ArchiveImageOwnershipHandle,
} from "@rip-dvd/worker-runtime";
import {
  createDvdRecoveryJournalDigest,
  DVD_RECOVERY_JOURNAL_MAGIC,
  DVD_RECOVERY_JOURNAL_NAME,
  type DvdRecoveryJournalMetadata,
} from "./dvd-recovery-journal.js";

const NATIVE_WRITER = "/usr/local/bin/rip-dvd-recovery-atomic-write";

export type DvdRecoveryBatchStep =
  | "journal"
  | "write"
  | "image_sync"
  | "manifest"
  | "pointer"
  | "database"
  | "cleanup";

export type DvdRecoveryReadObservation = {
  startLba: number;
  outcome: "failed";
} | {
  startLba: number;
  outcome: "recovered";
  bytes: Buffer;
};

export type DvdRecoveryBatchFaultCode =
  | "CONSISTENCY_FAULT"
  | "WRITER_NOT_QUIESCENT"
  | "DISC_VERIFICATION_STALE"
  | "STORAGE_UNSUPPORTED"
  | "JOURNAL_CAPACITY_INSUFFICIENT"
  | "JOURNAL_RESERVATION_FAILED"
  | "JOURNAL_SYNC_FAILED"
  | "IMAGE_WRITE_FAILED"
  | "IMAGE_SYNC_FAILED"
  | "CHECKPOINT_CAPACITY_EXHAUSTED"
  | "CHECKPOINT_SYNC_FAILED"
  | "CHECKPOINT_REPLACEMENT_FAILED";

interface DvdRecoveryBatchFaultOptions extends ErrorOptions {
  retainRecoveryWork?: boolean;
  storageFault?: boolean;
}

export class DvdRecoveryBatchFault extends Error {
  override readonly name = "DvdRecoveryBatchFault";
  readonly retainRecoveryWork: boolean;
  readonly storageFault: boolean;

  constructor(
    readonly code: DvdRecoveryBatchFaultCode,
    options?: DvdRecoveryBatchFaultOptions,
  ) {
    super(code, options);
    this.retainRecoveryWork = options?.retainRecoveryWork ?? false;
    this.storageFault = options?.storageFault ?? false;
  }
}

function archiveImageOwnershipFaultCode(
  cause: unknown,
): "WRITER_NOT_QUIESCENT" | "CONSISTENCY_FAULT" | null {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = cause.code;
    if (code === "WRITER_NOT_QUIESCENT" || code === "CONSISTENCY_FAULT") {
      return code;
    }
  }
  return null;
}

export interface DvdRecoveryAtomicWriter {
  inspect(input: {
    imagePath: string;
    filesystemIdentity: string;
    ownershipDescriptor: number;
  }): {
    contract: typeof DVD_RECOVERY_ATOMIC_WRITE_CONTRACT;
    unitBytes: number;
    memoryAlignmentBytes: number;
  };
  write(input: {
    imagePath: string;
    filesystemIdentity: string;
    ownershipDescriptor: number;
    startByte: number;
    bytes: Buffer;
    unitBytes: number;
  }): { bytesWritten: number; unitBytes: number };
  restoreVersion?(input: {
    imagePath: string;
    filesystemIdentity: string;
    ownershipDescriptor: number;
    mtimeNs: string;
  }): { mtimeNs: string };
}

function nativeImageIdentityArgs(filesystemIdentity: string): [string, string] {
  const match = /^(\d+):(\d+)$/.exec(filesystemIdentity);
  if (match === null) throw new Error("Archive image identity is malformed");
  return [match[1]!, match[2]!];
}

function parseNativeResult(result: ReturnType<typeof spawnSync>): Record<string, unknown> {
  if (result.error !== undefined || result.status !== 0) {
    throw result.error ?? new Error(result.stderr?.toString() || "Atomic recovery helper failed");
  }
  const parsed: unknown = JSON.parse(result.stdout?.toString() ?? "");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Atomic recovery helper result is malformed");
  }
  return parsed as Record<string, unknown>;
}

export const nodeDvdRecoveryAtomicWriter: DvdRecoveryAtomicWriter = {
  inspect({ imagePath, filesystemIdentity, ownershipDescriptor }) {
    const identity = nativeImageIdentityArgs(filesystemIdentity);
    const result = parseNativeResult(spawnSync(
      NATIVE_WRITER,
      ["inspect", imagePath, ...identity],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", ownershipDescriptor] },
    ));
    if (result.status !== "supported" ||
      !Number.isSafeInteger(result.unitBytes) || Number(result.unitBytes) < 1 ||
      !Number.isSafeInteger(result.memoryAlignmentBytes) || Number(result.memoryAlignmentBytes) < 1) {
      throw new Error("Archive inode does not support atomic recovery writes");
    }
    return {
      contract: DVD_RECOVERY_ATOMIC_WRITE_CONTRACT,
      unitBytes: Number(result.unitBytes),
      memoryAlignmentBytes: Number(result.memoryAlignmentBytes),
    };
  },
  write({ imagePath, filesystemIdentity, ownershipDescriptor, startByte, bytes, unitBytes }) {
    const identity = nativeImageIdentityArgs(filesystemIdentity);
    const result = parseNativeResult(spawnSync(
      NATIVE_WRITER,
      ["write", imagePath, String(startByte), String(unitBytes), ...identity],
      {
        input: bytes,
        maxBuffer: DVD_RECOVERY_JOURNAL_RESERVATION_BYTES,
        stdio: ["pipe", "pipe", "pipe", ownershipDescriptor],
      },
    ));
    return {
      bytesWritten: Number(result.bytesWritten),
      unitBytes: Number(result.unitBytes),
    };
  },
  restoreVersion({
    imagePath,
    filesystemIdentity,
    ownershipDescriptor,
    mtimeNs,
  }) {
    const identity = nativeImageIdentityArgs(filesystemIdentity);
    const result = parseNativeResult(spawnSync(
      NATIVE_WRITER,
      ["restore-version", imagePath, mtimeNs, ...identity],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", ownershipDescriptor],
      },
    ));
    if (result.status !== "restored" || result.mtimeNs !== mtimeNs) {
      throw new Error("Atomic recovery helper did not restore image version");
    }
    return { mtimeNs };
  },
};

interface RecoveryPaths {
  root: string;
  directory: string;
  image: string;
  journal: string;
  pointer: string;
}

export interface DvdRecoveryBatchOptions {
  access: DataAccess;
  originalsLibraryPath: string;
  originalDiscArchiveId: OriginalDiscArchiveId;
  recoveryWorkClaim: ClaimedArchiveRecoveryWork;
  writeAuthority: DvdRecoveryWriteAuthority;
  observation: DvdRecoveryReadObservation;
  archiveImageOwnership?: ArchiveImageOwnership;
  atomicWriter?: DvdRecoveryAtomicWriter;
  readCheckpoint?: typeof readCommittedDvdCheckpoint;
  directorySync?(path: string): Promise<void>;
  signal?: AbortSignal;
  fault?(point: `before:${DvdRecoveryBatchStep}` | `after:${DvdRecoveryBatchStep}`): void | Promise<void>;
}

function assertRecoveryWorkClaim(options: DvdRecoveryBatchOptions): void {
  if (
    options.recoveryWorkClaim.originalDiscArchiveId !==
      options.originalDiscArchiveId
  ) {
    throw new Error("Archive Recovery work claim targets another archive");
  }
  options.access.archiveRecoveryWork.assertClaim(options.recoveryWorkClaim);
}

function sameWriteAuthority(
  authority: DvdRecoveryWriteAuthority,
  verification: NonNullable<ReturnType<
    DataAccess["dvdDiscVerifications"]["find"]
  >>,
): boolean {
  return verification.id === authority.verificationId &&
    verification.archiveRecoveryId === authority.archiveRecoveryId &&
    verification.archiveRecoveryAttemptId ===
      authority.archiveRecoveryAttemptId &&
    verification.originalDiscArchiveId === authority.originalDiscArchiveId &&
    verification.discInspectionId === authority.discInspectionId &&
    verification.detectedDiscId === authority.detectedDiscId &&
    verification.mediaGeneration === authority.mediaGeneration &&
    verification.workerExecutionId ===
      authority.verificationWorkerExecutionId &&
    verification.checkpointRevision === authority.checkpointRevision &&
    verification.checkpointDigest === authority.checkpointDigest;
}

function assertRecoveryWriteAuthority(
  options: DvdRecoveryBatchOptions,
  requireBaseCheckpoint: boolean,
): void {
  const authority = options.writeAuthority;
  const recovery = options.access.archiveRecoveryWork.assertClaim(
    options.recoveryWorkClaim,
  );
  const verification = options.access.dvdDiscVerifications.find(
    authority.verificationId,
  );
  const latest = options.access.dvdDiscVerifications.findLatestForRecovery(
    options.recoveryWorkClaim.archiveRecoveryId,
  );
  const confirmationId = authority.discConfirmationId ?? null;
  const confirmation = confirmationId === null
    ? null
    : options.access.dvdDiscConfirmations.find(confirmationId);
  const confirmedAuthority = confirmation === null || verification === null
    ? null
    : dvdConfirmedRecoveryWriteAuthority(verification, confirmation);
  const inspection = verification === null
    ? null
    : options.access.discInspections.list({
        ids: [verification.discInspectionId],
      })[0] ?? null;
  const archive = options.access.catalog.listOriginalDiscArchives({
    ids: [options.originalDiscArchiveId],
  })[0];
  const detectedDisc = verification === null
    ? undefined
    : options.access.catalog.listDetectedDiscs(undefined, {
        ids: [verification.detectedDiscId],
      })[0];
  const header = requireBaseCheckpoint
    ? options.access.catalog.findDvdArchiveEvidenceHeader(
        options.originalDiscArchiveId,
      )
    : null;
  if (
    authority.originalDiscArchiveId !== options.originalDiscArchiveId ||
    authority.archiveRecoveryId !==
      options.recoveryWorkClaim.archiveRecoveryId ||
    authority.archiveRecoveryAttemptId !==
      options.recoveryWorkClaim.attemptId ||
    recovery.attemptId !== authority.archiveRecoveryAttemptId ||
    verification === null ||
    latest?.id !== verification.id ||
    verification.status !== "completed" ||
    recovery.work?.verificationId !== verification.id ||
    archive === undefined ||
    detectedDisc === undefined ||
    !sameWriteAuthority(authority, verification) ||
    (confirmationId === null
      ? verification.outcome !== "match" ||
        recovery.work?.discConfirmationId != null ||
        verification.sourceMetadataFingerprint !==
          verification.observedMetadataFingerprint ||
        verification.sourceMetadataFingerprint !== archive.fingerprint ||
        verification.observedMetadataFingerprint !== detectedDisc.fingerprint
      : confirmedAuthority === null ||
        confirmedAuthority.discConfirmationId !== confirmationId ||
        recovery.work?.discConfirmationId !== confirmationId ||
        recovery.work?.claimedBy !==
          confirmation?.verificationWorkerExecutionId) ||
    !dvdDiscVerificationInsertionIsCurrent(verification, inspection) ||
    requireBaseCheckpoint && (
      header === null ||
      header.currentManifestRevision < verification.checkpointRevision ||
      header.currentManifestRevision === verification.checkpointRevision &&
        header.currentManifestDigest !== verification.checkpointDigest
    )
  ) {
    throw new DvdRecoveryBatchFault("DISC_VERIFICATION_STALE");
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isMissingOrUnsafeEvidencePath(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "ELOOP"].some((code) => hasCode(error, code));
}

async function syncDirectory(
  path: string,
  faultCode: Extract<
    DvdRecoveryBatchFaultCode,
    "JOURNAL_SYNC_FAILED" | "CHECKPOINT_SYNC_FAILED" |
      "CHECKPOINT_REPLACEMENT_FAILED"
  >,
  synchronize: (path: string) => Promise<void> = async (directoryPath) => {
    const directory = await open(
      directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  },
): Promise<void> {
  try {
    await synchronize(path);
  } catch (cause) {
    throw new DvdRecoveryBatchFault(faultCode, {
      cause,
      storageFault: true,
    });
  }
}

async function pathsFor(options: DvdRecoveryBatchOptions): Promise<RecoveryPaths> {
  const id = options.originalDiscArchiveId;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT");
  }
  let root;
  try {
    root = await realpath(options.originalsLibraryPath);
  } catch (cause) {
    throw new DvdRecoveryBatchFault("STORAGE_UNSUPPORTED", {
      cause,
      storageFault: true,
    });
  }
  const directory = join(root, ".dvd-evidence", id);
  const image = join(root, `${id}.iso`);
  let resolvedDirectory;
  try {
    resolvedDirectory = await realpath(directory);
  } catch (cause) {
    if (isMissingOrUnsafeEvidencePath(cause)) {
      throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT", { cause });
    }
    throw new DvdRecoveryBatchFault("STORAGE_UNSUPPORTED", {
      cause,
      storageFault: true,
    });
  }
  if (resolvedDirectory !== directory) {
    throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT");
  }
  return {
    root,
    directory,
    image,
    journal: join(directory, DVD_RECOVERY_JOURNAL_NAME),
    pointer: join(directory, "checkpoint.json"),
  };
}

async function step(
  options: DvdRecoveryBatchOptions,
  ownership: ArchiveImageOwnershipHandle,
  name: DvdRecoveryBatchStep,
  work: () => Promise<void>,
): Promise<void> {
  let mutationStarted = false;
  try {
    assertRecoveryWorkClaim(options);
    assertRecoveryWriteAuthority(options, name !== "cleanup");
    options.signal?.throwIfAborted();
    ownership.assertOwned();
    await options.fault?.(`before:${name}`);
    assertRecoveryWorkClaim(options);
    assertRecoveryWriteAuthority(options, name !== "cleanup");
    options.signal?.throwIfAborted();
    ownership.assertOwned();
    mutationStarted = true;
    await work();
    assertRecoveryWorkClaim(options);
    await options.fault?.(`after:${name}`);
    assertRecoveryWorkClaim(options);
    options.signal?.throwIfAborted();
    ownership.assertOwned();
  } catch (cause) {
    if (!mutationStarted) throw cause;
    if (cause instanceof DvdRecoveryBatchFault) {
      if (cause.retainRecoveryWork) throw cause;
      throw new DvdRecoveryBatchFault(cause.code, {
        cause,
        retainRecoveryWork: true,
        storageFault: cause.storageFault,
      });
    }
    throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT", {
      cause,
      retainRecoveryWork: true,
    });
  }
}

async function readImageVersion(
  path: string,
  expected: { filesystemIdentity: string; mtimeNs: string },
  sizeBytes: number,
): Promise<{ descriptor: Awaited<ReturnType<typeof open>>; filesystemIdentity: string; mtimeNs: string }> {
  const descriptor = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((cause) => {
    if (isMissingOrUnsafeEvidencePath(cause)) {
      throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT", { cause });
    }
    throw new DvdRecoveryBatchFault("IMAGE_SYNC_FAILED", {
      cause,
      storageFault: true,
    });
  });
  try {
    let stat;
    let named;
    try {
      stat = await descriptor.stat({ bigint: true });
      named = await lstat(path, { bigint: true });
    } catch (cause) {
      if (isMissingOrUnsafeEvidencePath(cause)) {
        throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT", { cause });
      }
      throw new DvdRecoveryBatchFault("IMAGE_SYNC_FAILED", {
        cause,
        storageFault: true,
      });
    }
    const filesystemIdentity = `${stat.dev}:${stat.ino}`;
    const mtimeNs = stat.mtimeNs.toString();
    if (!stat.isFile() || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino ||
      stat.size !== BigInt(sizeBytes) || filesystemIdentity !== expected.filesystemIdentity || mtimeNs !== expected.mtimeNs) {
      throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT");
    }
    return { descriptor, filesystemIdentity, mtimeNs };
  } catch (error) {
    try {
      await descriptor.close();
    } catch (cause) {
      throw new DvdRecoveryBatchFault("IMAGE_SYNC_FAILED", {
        cause,
        storageFault: true,
      });
    }
    throw error;
  }
}

async function reserveJournal(
  path: string,
  metadata: Omit<DvdRecoveryJournalMetadata, "journalDigest">,
  originalBytes: Buffer,
): Promise<string> {
  const journalDigest = createDvdRecoveryJournalDigest(
    metadata,
    originalBytes,
  );
  const complete: DvdRecoveryJournalMetadata = { ...metadata, journalDigest };
  const metadataBytes = Buffer.from(canonicalPublicationJson(complete));
  const magic = Buffer.from(DVD_RECOVERY_JOURNAL_MAGIC);
  const headerPrefixBytes = magic.length + 4 + 32;
  if (headerPrefixBytes + metadataBytes.length > DVD_RECOVERY_JOURNAL_METADATA_BYTES ||
    originalBytes.length > DVD_RECOVERY_JOURNAL_PAYLOAD_BYTES) {
    throw new DvdRecoveryBatchFault("JOURNAL_CAPACITY_INSUFFICIENT");
  }
  const descriptor = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  ).catch((cause) => {
    const exists = hasCode(cause, "EEXIST");
    throw new DvdRecoveryBatchFault(
      exists ? "CONSISTENCY_FAULT" : "JOURNAL_RESERVATION_FAILED",
      { cause, storageFault: !exists },
    );
  });
  try {
    const reserved = Buffer.alloc(64 * 1024);
    let position = 0;
    try {
      while (position < DVD_RECOVERY_JOURNAL_RESERVATION_BYTES) {
        const length = Math.min(reserved.length, DVD_RECOVERY_JOURNAL_RESERVATION_BYTES - position);
        const result = await descriptor.write(reserved, 0, length, position);
        if (result.bytesWritten !== length) throw new Error("Journal reservation write was partial");
        position += result.bytesWritten;
      }
    } catch (cause) {
      throw new DvdRecoveryBatchFault("JOURNAL_RESERVATION_FAILED", {
        cause,
        storageFault: true,
      });
    }
    await descriptor.sync();
    const header = Buffer.alloc(DVD_RECOVERY_JOURNAL_METADATA_BYTES);
    magic.copy(header);
    header.writeUInt32BE(metadataBytes.length, magic.length);
    Buffer.from(sha256(metadataBytes), "hex").copy(header, magic.length + 4);
    metadataBytes.copy(header, headerPrefixBytes);
    if ((await descriptor.write(header, 0, header.length, 0)).bytesWritten !== header.length ||
      (await descriptor.write(originalBytes, 0, originalBytes.length, DVD_RECOVERY_JOURNAL_METADATA_BYTES)).bytesWritten !== originalBytes.length) {
      throw new Error("Journal evidence write was partial");
    }
    await descriptor.sync();
    const stat = await descriptor.stat();
    if (stat.size !== DVD_RECOVERY_JOURNAL_RESERVATION_BYTES) throw new Error("Journal reservation size changed");
    return journalDigest;
  } catch (cause) {
    if (cause instanceof DvdRecoveryBatchFault) throw cause;
    throw new DvdRecoveryBatchFault("JOURNAL_SYNC_FAILED", {
      cause,
      storageFault: true,
    });
  } finally {
    try {
      await descriptor.close();
    } catch (cause) {
      throw new DvdRecoveryBatchFault("JOURNAL_SYNC_FAILED", {
        cause,
        storageFault: true,
      });
    }
  }
}

async function installImmutableRecord(
  path: string,
  value: unknown,
  directorySync?: (path: string) => Promise<void>,
): Promise<void> {
  const bytes = canonicalPublicationJson(value);
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== bytes) {
      throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT");
    }
    const descriptor = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch((cause) => {
      throw new DvdRecoveryBatchFault("CHECKPOINT_SYNC_FAILED", {
        cause,
        storageFault: true,
      });
    });
    try {
      await descriptor.sync();
    } catch (cause) {
      throw new DvdRecoveryBatchFault("CHECKPOINT_SYNC_FAILED", {
        cause,
        storageFault: true,
      });
    } finally {
      try {
        await descriptor.close();
      } catch (cause) {
        throw new DvdRecoveryBatchFault("CHECKPOINT_SYNC_FAILED", {
          cause,
          storageFault: true,
        });
      }
    }
    await syncDirectory(
      dirname(path),
      "CHECKPOINT_SYNC_FAILED",
      directorySync,
    );
    return;
  } catch (error) {
    if (error instanceof DvdRecoveryBatchFault) throw error;
    if (!hasCode(error, "ENOENT")) {
      throw new DvdRecoveryBatchFault("CHECKPOINT_SYNC_FAILED", {
        cause: error,
        storageFault: true,
      });
    }
  }
  const temporary = `${path}.${process.pid}.tmp`;
  const descriptor = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  ).catch((cause) => {
    const exists = hasCode(cause, "EEXIST");
    throw new DvdRecoveryBatchFault(
      exists ? "CONSISTENCY_FAULT" : "CHECKPOINT_SYNC_FAILED",
      { cause, storageFault: !exists },
    );
  });
  try {
    await descriptor.writeFile(bytes);
    await descriptor.sync();
  } catch (cause) {
    throw new DvdRecoveryBatchFault("CHECKPOINT_SYNC_FAILED", {
      cause,
      storageFault: true,
    });
  } finally {
    try {
      await descriptor.close();
    } catch (cause) {
      throw new DvdRecoveryBatchFault("CHECKPOINT_SYNC_FAILED", {
        cause,
        storageFault: true,
      });
    }
  }
  try {
    await link(temporary, path).catch((cause) => {
      const exists = hasCode(cause, "EEXIST");
      throw new DvdRecoveryBatchFault(
        exists ? "CONSISTENCY_FAULT" : "CHECKPOINT_SYNC_FAILED",
        { cause, storageFault: !exists },
      );
    });
    await syncDirectory(
      dirname(path),
      "CHECKPOINT_SYNC_FAILED",
      directorySync,
    );
  } finally {
    try {
      await unlink(temporary);
    } catch (cause) {
      throw new DvdRecoveryBatchFault("CHECKPOINT_SYNC_FAILED", {
        cause,
        storageFault: true,
      });
    }
    await syncDirectory(
      dirname(path),
      "CHECKPOINT_SYNC_FAILED",
      directorySync,
    );
  }
}

async function replacePointer(
  path: string,
  value: unknown,
  directorySync?: (path: string) => Promise<void>,
): Promise<void> {
  const temporary = `${path}.${process.pid}.next`;
  const descriptor = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  ).catch((cause) => {
    const exists = hasCode(cause, "EEXIST");
    throw new DvdRecoveryBatchFault(
      exists ? "CONSISTENCY_FAULT" : "CHECKPOINT_REPLACEMENT_FAILED",
      { cause, storageFault: !exists },
    );
  });
  try {
    await descriptor.writeFile(canonicalPublicationJson(value));
    await descriptor.sync();
  } catch (cause) {
    throw new DvdRecoveryBatchFault("CHECKPOINT_REPLACEMENT_FAILED", {
      cause,
      storageFault: true,
    });
  } finally {
    try {
      await descriptor.close();
    } catch (cause) {
      throw new DvdRecoveryBatchFault("CHECKPOINT_REPLACEMENT_FAILED", {
        cause,
        storageFault: true,
      });
    }
  }
  try {
    await rename(temporary, path).catch((cause) => {
      throw new DvdRecoveryBatchFault("CHECKPOINT_REPLACEMENT_FAILED", {
        cause,
        storageFault: true,
      });
    });
    await syncDirectory(
      dirname(path),
      "CHECKPOINT_REPLACEMENT_FAILED",
      directorySync,
    );
  } finally {
    try {
      await unlink(temporary);
    } catch (cause) {
      if (!hasCode(cause, "ENOENT")) {
        throw new DvdRecoveryBatchFault("CHECKPOINT_REPLACEMENT_FAILED", {
          cause,
          storageFault: true,
        });
      }
    }
  }
  let installed;
  try {
    installed = await readFile(path, "utf8");
  } catch (cause) {
    if (isMissingOrUnsafeEvidencePath(cause)) {
      throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT", { cause });
    }
    throw new DvdRecoveryBatchFault("CHECKPOINT_REPLACEMENT_FAILED", {
      cause,
      storageFault: true,
    });
  }
  if (installed !== canonicalPublicationJson(value)) {
    throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT");
  }
}

function recoveryReadFor(
  archiveId: OriginalDiscArchiveId,
  current: CommittedDvdCheckpointEvidence,
  observation: DvdRecoveryReadObservation,
  authority: DvdRecoveryWriteAuthority,
) {
  const input = {
    originalDiscArchiveId: archiveId,
    fromManifestId: current.id,
    fromManifestRevision: current.revision,
    startLba: observation.startLba,
    sectorCount: 1,
    outcome: observation.outcome,
    verificationId: authority.verificationId,
    discConfirmationId: authority.discConfirmationId ?? null,
  } as const;
  return {
    id: `${archiveId}:recovery-read:${current.revision + 1}`,
    ...input,
    evidenceDigest: createDvdArchiveRecoveryReadEvidenceDigest(input),
  };
}

function recoveryManifestFor(input: {
  current: CommittedDvdCheckpointEvidence;
  recoveryRead: ReturnType<typeof recoveryReadFor>;
  image: { filesystemIdentity: string; mtimeNs: string };
  nextRanges: DvdArchiveEvidenceHeader["unrecoveredSourceRanges"];
  journalDigest: string | null;
  protectedRanges: readonly DvdRecoveryProtectedRange[];
}): CommittedDvdRecoveryEvidence {
  const { current, recoveryRead } = input;
  const digestInput = {
    originalDiscArchiveId: current.originalDiscArchiveId,
    revision: current.revision + 1,
    previousManifestId: current.id,
    previousManifestDigest: current.manifestDigest,
    recoveryReadId: recoveryRead.id,
    recoveryReadEvidenceDigest: recoveryRead.evidenceDigest,
    evidenceFormat: current.evidenceFormat,
    imageFingerprint: current.imageFingerprint,
    sectorSizeBytes: current.sectorSizeBytes,
    acceptedEndLbaExclusive: current.acceptedEndLbaExclusive,
    boundaryPolicyVersion: current.boundaryPolicyVersion,
    boundaryReportedSizeBytes: current.boundaryReportedSizeBytes,
    boundaryPublishedSizeBytes: current.boundaryPublishedSizeBytes,
    boundaryEvidenceDigest: current.boundaryEvidenceDigest,
    unrecoveredSourceRanges: input.nextRanges,
  } as const;
  const payload = {
    ...digestInput,
    ...createDvdArchiveEvidenceManifestDigests(digestInput),
    id: `${current.originalDiscArchiveId}:recovery:${current.revision + 1}`,
    checkpointFormat: "dvd-recovery-batch-v1" as const,
    sourceArchiveJobId: current.sourceArchiveJobId,
    rootPublicationDigest: "rootPublicationDigest" in current
      ? current.rootPublicationDigest
      : current.publicationDigest,
    previousPublicationDigest: current.publicationDigest,
    image: input.image,
    previousImage: current.image,
    boundaryEvidence: current.boundaryEvidence,
    recoveryRead,
    journalDigest: input.journalDigest,
    protectedRanges: input.protectedRanges,
  };
  return {
    ...payload,
    publicationDigest: createDvdRecoveryCheckpointPublicationDigest(payload),
  };
}

async function runOwnedBatch(
  options: DvdRecoveryBatchOptions,
  ownership: ArchiveImageOwnershipHandle,
  paths: RecoveryPaths,
): Promise<{ manifest: CommittedDvdRecoveryEvidence; header: DvdArchiveEvidenceHeader }> {
  assertRecoveryWorkClaim(options);
  assertRecoveryWriteAuthority(options, true);
  const archive = options.access.catalog.listOriginalDiscArchives({ ids: [options.originalDiscArchiveId] })[0];
  const header = options.access.catalog.findDvdArchiveEvidenceHeader(options.originalDiscArchiveId);
  const recovery = options.access.catalog.findArchiveRecovery(options.originalDiscArchiveId);
  const jobs = options.access.archiveJobs.listForArchive(options.originalDiscArchiveId);
  if (
    !archive || !header ||
    recovery === null ||
    !(["running", "stopping"] as const).includes(
      recovery.status as "running" | "stopping",
    ) ||
    resolve(archive.archivePath) !== paths.image
  ) {
    throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT");
  }
  const reconciliation = options.access.dvdRecoveryReconciliations
    .findLatestForRecovery(recovery.id);
  if (reconciliation !== null && reconciliation.status !== "completed") {
    throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT");
  }
  if (header.currentManifestRevision >= DVD_RECOVERY_MAX_CHECKPOINT_REVISION) {
    throw new DvdRecoveryBatchFault("CHECKPOINT_CAPACITY_EXHAUSTED");
  }
  const storage = options.access.dvdRecoveryStorage.readCurrent();
  const protection = storage?.facts.mutationProtection;
  if (storage?.status !== "supported" || protection?.status !== "verified") {
    throw new DvdRecoveryBatchFault("STORAGE_UNSUPPORTED", {
      storageFault: true,
    });
  }
  const current = await (options.readCheckpoint ?? readCommittedDvdCheckpoint)({
    originalsLibraryPath: paths.root,
    archive,
    header,
    jobs,
    assertImageOwnership: ownership.assertOwned,
  });
  if (!current || current.revision !== header.currentManifestRevision ||
    current.manifestDigest !== header.currentManifestDigest) {
    throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT");
  }
  if (
    current.revision < options.writeAuthority.checkpointRevision ||
    current.revision === options.writeAuthority.checkpointRevision &&
      current.manifestDigest !== options.writeAuthority.checkpointDigest
  ) {
    throw new DvdRecoveryBatchFault("DISC_VERIFICATION_STALE");
  }
  if (!Number.isSafeInteger(options.observation.startLba) || options.observation.startLba < 0 ||
    (options.observation.outcome === "recovered" && options.observation.bytes.length !== 2_048)) {
    throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT");
  }
  const targetedRange = current.unrecoveredSourceRanges.find((range) =>
    options.observation.startLba >= range.startLba &&
    options.observation.startLba < range.startLba + range.sectorCount
  );
  if (targetedRange === undefined) {
    throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT");
  }
  const recoveryRead = recoveryReadFor(
    options.originalDiscArchiveId,
    current,
    options.observation,
    options.writeAuthority,
  );
  let image = current.image;
  let journalDigest: string | null = null;
  let protectedRanges: readonly DvdRecoveryProtectedRange[] = [];

  if (options.observation.outcome === "recovered") {
    const atomicWriter = options.atomicWriter ?? nodeDvdRecoveryAtomicWriter;
    let actualProtection;
    try {
      actualProtection = atomicWriter.inspect({
        imagePath: paths.image,
        filesystemIdentity: current.image.filesystemIdentity,
        ownershipDescriptor: ownership.descriptor,
      });
    } catch (cause) {
      throw new DvdRecoveryBatchFault("STORAGE_UNSUPPORTED", {
        cause,
        storageFault: true,
      });
    }
    if (actualProtection.contract !== protection.contract ||
      actualProtection.unitBytes !== protection.unitBytes ||
      actualProtection.memoryAlignmentBytes !== protection.memoryAlignmentBytes) {
      throw new DvdRecoveryBatchFault("STORAGE_UNSUPPORTED", {
        storageFault: true,
      });
    }
    const sectorStart = options.observation.startLba * 2_048;
    const startByte = Math.floor(sectorStart / protection.unitBytes) * protection.unitBytes;
    const endByte = Math.ceil((sectorStart + 2_048) / protection.unitBytes) * protection.unitBytes;
    const byteCount = endByte - startByte;
    if (!Number.isSafeInteger(sectorStart) || endByte > current.boundaryPublishedSizeBytes ||
      byteCount > DVD_RECOVERY_JOURNAL_PAYLOAD_BYTES) {
      throw new DvdRecoveryBatchFault("JOURNAL_CAPACITY_INSUFFICIENT");
    }
    const beforeVersion = await readImageVersion(
      paths.image,
      current.image,
      current.boundaryPublishedSizeBytes,
    );
    const before = Buffer.alloc(byteCount);
    try {
      const read = await beforeVersion.descriptor.read(
        before,
        0,
        byteCount,
        startByte,
      );
      if (read.bytesRead !== byteCount) {
        throw new Error("Protected image read was partial");
      }
    } catch (cause) {
      throw new DvdRecoveryBatchFault("IMAGE_SYNC_FAILED", {
        cause,
        storageFault: true,
      });
    } finally {
      try {
        await beforeVersion.descriptor.close();
      } catch (cause) {
        throw new DvdRecoveryBatchFault("IMAGE_SYNC_FAILED", {
          cause,
          storageFault: true,
        });
      }
    }
    const after = Buffer.from(before);
    options.observation.bytes.copy(after, sectorStart - startByte);
    protectedRanges = Array.from(
      { length: byteCount / protection.unitBytes },
      (_, index) => {
        const payloadOffset = index * protection.unitBytes;
        return {
          startByte: startByte + payloadOffset,
          byteCount: protection.unitBytes,
          unitBytes: protection.unitBytes,
          beforeDigest: sha256(before.subarray(
            payloadOffset,
            payloadOffset + protection.unitBytes,
          )),
          afterDigest: sha256(after.subarray(
            payloadOffset,
            payloadOffset + protection.unitBytes,
          )),
        };
      },
    );
    const journalWithoutDigest: Omit<
      DvdRecoveryJournalMetadata,
      "journalDigest"
    > = {
      version: "dvd-recovery-journal-v1",
      originalDiscArchiveId: options.originalDiscArchiveId,
      image: {
        filesystemIdentity: beforeVersion.filesystemIdentity,
        mtimeNs: beforeVersion.mtimeNs,
        sizeBytes: current.boundaryPublishedSizeBytes,
      },
      base: {
        manifestId: current.id,
        revision: current.revision,
        manifestDigest: current.manifestDigest,
        publicationDigest: current.publicationDigest,
        unrecoveredSourceRanges: current.unrecoveredSourceRanges,
      },
      recoveryRead: {
        id: recoveryRead.id,
        startLba: recoveryRead.startLba,
        sectorCount: 1,
        outcome: "recovered",
        sourceBytesDigest: sha256(options.observation.bytes),
      },
      protectedRanges: protectedRanges.map((range, index) => ({
        ...range,
        payloadOffset: index * protection.unitBytes,
      })),
    };
    await step(options, ownership, "journal", async () => {
      journalDigest = await reserveJournal(paths.journal, journalWithoutDigest, before);
      await syncDirectory(
        paths.directory,
        "JOURNAL_SYNC_FAILED",
        options.directorySync,
      );
    });
    await step(options, ownership, "write", async () => {
      for (let index = 0; index < protectedRanges.length; index += 1) {
        const range = protectedRanges[index]!;
        let result;
        try {
          result = atomicWriter.write({
            imagePath: paths.image,
            filesystemIdentity: current.image.filesystemIdentity,
            ownershipDescriptor: ownership.descriptor,
            startByte: range.startByte,
            bytes: after.subarray(
              index * protection.unitBytes,
              (index + 1) * protection.unitBytes,
            ),
            unitBytes: protection.unitBytes,
          });
        } catch (cause) {
          throw new DvdRecoveryBatchFault("IMAGE_WRITE_FAILED", {
            cause,
            storageFault: true,
          });
        }
        if (result.bytesWritten !== protection.unitBytes ||
          result.unitBytes !== protection.unitBytes) {
          throw new DvdRecoveryBatchFault("IMAGE_WRITE_FAILED", {
            storageFault: true,
          });
        }
      }
    });
    await step(options, ownership, "image_sync", async () => {
      const descriptor = await open(paths.image, constants.O_RDONLY | constants.O_NOFOLLOW)
        .catch((cause) => {
          throw new DvdRecoveryBatchFault("IMAGE_SYNC_FAILED", {
            cause,
            storageFault: true,
          });
        });
      try {
        try {
          await descriptor.sync();
        } catch (cause) {
          throw new DvdRecoveryBatchFault("IMAGE_SYNC_FAILED", {
            cause,
            storageFault: true,
          });
        }
        const actual = Buffer.alloc(after.length);
        let read;
        try {
          read = await descriptor.read(actual, 0, actual.length, startByte);
        } catch (cause) {
          throw new DvdRecoveryBatchFault("IMAGE_SYNC_FAILED", {
            cause,
            storageFault: true,
          });
        }
        if (read.bytesRead !== actual.length || !actual.equals(after)) throw new Error("Protected image verification failed");
        let stat;
        let named;
        try {
          stat = await descriptor.stat({ bigint: true });
          named = await lstat(paths.image, { bigint: true });
        } catch (cause) {
          throw new DvdRecoveryBatchFault("IMAGE_SYNC_FAILED", {
            cause,
            storageFault: true,
          });
        }
        if (stat.dev !== named.dev || stat.ino !== named.ino || stat.size !== BigInt(current.boundaryPublishedSizeBytes) ||
          `${stat.dev}:${stat.ino}` !== current.image.filesystemIdentity) throw new Error("Image identity changed");
        image = { filesystemIdentity: `${stat.dev}:${stat.ino}`, mtimeNs: stat.mtimeNs.toString() };
      } catch (cause) {
        if (cause instanceof DvdRecoveryBatchFault) throw cause;
        throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT", { cause });
      } finally {
        try {
          await descriptor.close();
        } catch (cause) {
          throw new DvdRecoveryBatchFault("IMAGE_SYNC_FAILED", {
            cause,
            storageFault: true,
          });
        }
      }
    });
  }

  const nextRanges = dvdEvidenceRangesAfterRecoveryRead(
    current.unrecoveredSourceRanges,
    options.observation.startLba,
    options.observation.outcome,
  );
  const manifest = recoveryManifestFor({
    current,
    recoveryRead,
    image,
    nextRanges,
    journalDigest,
    protectedRanges,
  });
  const manifestPath = join(paths.directory, `recovery-manifest-${manifest.revision}.json`);
  await step(options, ownership, "manifest", async () => {
    await installImmutableRecord(
      manifestPath,
      manifest,
      options.directorySync,
    );
  });
  const currentPointer = {
    originalDiscArchiveId: current.originalDiscArchiveId,
    currentManifestId: current.id,
    currentManifestRevision: current.revision,
    currentManifestDigest: current.manifestDigest,
    publicationDigest: current.publicationDigest,
  };
  const nextPointer = {
    originalDiscArchiveId: manifest.originalDiscArchiveId,
    currentManifestId: manifest.id,
    currentManifestRevision: manifest.revision,
    currentManifestDigest: manifest.manifestDigest,
    publicationDigest: manifest.publicationDigest,
  };
  await step(options, ownership, "pointer", async () => {
    let currentBytes;
    try {
      currentBytes = await readFile(paths.pointer, "utf8");
    } catch (cause) {
      if (isMissingOrUnsafeEvidencePath(cause)) {
        throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT", { cause });
      }
      throw new DvdRecoveryBatchFault("CHECKPOINT_REPLACEMENT_FAILED", {
        cause,
        storageFault: true,
      });
    }
    if (currentBytes !== canonicalPublicationJson(currentPointer)) {
      throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT");
    }
    await replacePointer(paths.pointer, nextPointer, options.directorySync);
  });
  let projected = header;
  await step(options, ownership, "database", async () => {
    projected = options.access.dvdRecovery.projectCheckpoint({
      claim: options.recoveryWorkClaim,
      recoveryRead,
      manifest,
    });
  });
  if (options.observation.outcome === "recovered") {
    await step(options, ownership, "cleanup", async () => {
      try {
        await unlink(paths.journal);
      } catch (cause) {
        if (isMissingOrUnsafeEvidencePath(cause)) {
          throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT", { cause });
        }
        throw new DvdRecoveryBatchFault("JOURNAL_SYNC_FAILED", {
          cause,
          storageFault: true,
        });
      }
      await syncDirectory(
        paths.directory,
        "JOURNAL_SYNC_FAILED",
        options.directorySync,
      );
    });
  }
  return { manifest, header: projected };
}

/**
 * Commit one bounded recovery evidence unit. The existing evidence contract
 * records one source-sector observation per revision; later pass scheduling
 * may call this repeatedly while archive ownership remains the serialization
 * boundary.
 */
export async function commitDvdRecoveryBatch(
  options: DvdRecoveryBatchOptions,
): Promise<{ manifest: CommittedDvdRecoveryEvidence; header: DvdArchiveEvidenceHeader }> {
  try {
    const recovery = options.access.archiveRecoveryWork.assertClaim(
      options.recoveryWorkClaim,
    );
    if (recovery.work?.status !== "claimed") {
      throw new Error("Archive Recovery work is not claimed");
    }
    const recoveryWorkClaim = recovery.work.verificationId === null
      ? options.access.archiveRecoveryWork.bindVerification(
        options.recoveryWorkClaim,
        options.writeAuthority,
      )
      : recovery.work as ClaimedArchiveRecoveryWork;
    const currentOptions = { ...options, recoveryWorkClaim };
    assertRecoveryWriteAuthority(currentOptions, true);
    const paths = await pathsFor(currentOptions);
    const signal = currentOptions.signal ?? new AbortController().signal;
    const ownership = currentOptions.archiveImageOwnership ??
      defaultArchiveImageOwnership;
    return await ownership.withWriter({
      archiveId: currentOptions.originalDiscArchiveId,
      imagePath: paths.image,
      originalsLibraryPath: paths.root,
      signal,
      task: (handle) => runOwnedBatch(currentOptions, handle, paths),
    });
  } catch (cause) {
    if (cause instanceof DvdRecoveryBatchFault) throw cause;
    if (cause instanceof DvdCheckpointReadFault) {
      throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT", {
        cause,
        storageFault: cause.storageFault,
      });
    }
    const ownershipFaultCode = archiveImageOwnershipFaultCode(cause);
    if (ownershipFaultCode !== null) {
      throw new DvdRecoveryBatchFault(ownershipFaultCode, {
        cause,
        retainRecoveryWork: true,
      });
    }
    throw new DvdRecoveryBatchFault("CONSISTENCY_FAULT", { cause });
  }
}
