import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalPublicationJson,
  readDvdCheckpointForReconciliation,
  readDvdRecoveryManifestForReconciliation,
  verifyDvdCheckpointImage,
  type CommittedDvdCheckpointEvidence,
  type CommittedDvdRecoveryEvidence,
  type DataAccess,
  type DvdRecoveryReconciliationEvidence,
  type DvdRecoveryReconciliationOutcome,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError,
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
  type ArchiveImageOwnershipHandle,
} from "@rip-dvd/worker-runtime";

import {
  nodeDvdRecoveryAtomicWriter,
  type DvdRecoveryAtomicWriter,
} from "./dvd-recovery-batch.js";
import {
  DVD_RECOVERY_JOURNAL_NAME,
  readDvdRecoveryJournal,
  type DvdRecoveryJournalMetadata,
} from "./dvd-recovery-journal.js";

export type DvdRecoveryReconciliationStep =
  | "examine"
  | "rollback"
  | "rollback_sync"
  | "projection"
  | "cleanup";

export type DvdRecoveryReconciliationFaultCode =
  | "CONSISTENCY_FAULT"
  | "WRITER_NOT_QUIESCENT"
  | "STORAGE_UNSUPPORTED";

export class DvdRecoveryReconciliationFault extends Error {
  override readonly name = "DvdRecoveryReconciliationFault";

  constructor(
    readonly code: DvdRecoveryReconciliationFaultCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export interface DvdRecoveryReconciliationOptions {
  access: DataAccess;
  originalsLibraryPath: string;
  originalDiscArchiveId: OriginalDiscArchiveId;
  archiveImageOwnership?: ArchiveImageOwnership;
  atomicWriter?: DvdRecoveryAtomicWriter;
  signal?: AbortSignal;
  releaseRecoveryWork?: boolean;
  assertClaim?(): void;
  setPhase?(phase:
    | "examining"
    | "rolling_back"
    | "projecting"
    | "cleaning_up"
  ): void;
  fault?(point:
    | `before:${DvdRecoveryReconciliationStep}`
    | `after:${DvdRecoveryReconciliationStep}`
  ): void | Promise<void>;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkpointIdentity(checkpoint: CommittedDvdCheckpointEvidence) {
  return {
    revision: checkpoint.revision,
    manifestId: checkpoint.id,
    manifestDigest: checkpoint.manifestDigest,
  };
}

function projectedIdentity(header: {
  currentManifestRevision: number;
  currentManifestId: string;
  currentManifestDigest: string;
}) {
  return {
    revision: header.currentManifestRevision,
    manifestId: header.currentManifestId,
    manifestDigest: header.currentManifestDigest,
  };
}

function sameCheckpoint(
  left: ReturnType<typeof checkpointIdentity>,
  right: ReturnType<typeof checkpointIdentity>,
): boolean {
  return left.revision === right.revision &&
    left.manifestId === right.manifestId &&
    left.manifestDigest === right.manifestDigest;
}

async function syncDirectory(path: string): Promise<void> {
  const descriptor = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

async function boundary<Result>(
  options: DvdRecoveryReconciliationOptions,
  ownership: ArchiveImageOwnershipHandle,
  step: DvdRecoveryReconciliationStep,
  phase: Parameters<NonNullable<
    DvdRecoveryReconciliationOptions["setPhase"]
  >>[0],
  work: () => Promise<Result>,
): Promise<Result> {
  options.assertClaim?.();
  options.signal?.throwIfAborted();
  ownership.assertOwned();
  options.setPhase?.(phase);
  await options.fault?.(`before:${step}`);
  options.assertClaim?.();
  ownership.assertOwned();
  const result = await work();
  options.assertClaim?.();
  ownership.assertOwned();
  await options.fault?.(`after:${step}`);
  options.assertClaim?.();
  options.signal?.throwIfAborted();
  ownership.assertOwned();
  return result;
}

function assertJournalBase(
  journal: DvdRecoveryJournalMetadata,
  current: CommittedDvdCheckpointEvidence,
  archiveId: OriginalDiscArchiveId,
): void {
  if (
    journal.originalDiscArchiveId !== archiveId ||
    journal.image.filesystemIdentity !== current.image.filesystemIdentity ||
    journal.image.mtimeNs !== current.image.mtimeNs ||
    journal.image.sizeBytes !== current.boundaryPublishedSizeBytes ||
    journal.base.manifestId !== current.id ||
    journal.base.revision !== current.revision ||
    journal.base.manifestDigest !== current.manifestDigest ||
    journal.base.publicationDigest !== current.publicationDigest ||
    canonicalPublicationJson(journal.base.unrecoveredSourceRanges) !==
      canonicalPublicationJson(current.unrecoveredSourceRanges) ||
    journal.recoveryRead.id !==
      `${archiveId}:recovery-read:${current.revision + 1}`
  ) {
    throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
  }
}

function assertJournalCommit(
  journal: DvdRecoveryJournalMetadata,
  manifest: CommittedDvdRecoveryEvidence,
): void {
  const protectedRanges = journal.protectedRanges.map(
    ({ payloadOffset: _payloadOffset, ...range }) => range,
  );
  if (
    manifest.revision !== journal.base.revision + 1 ||
    manifest.previousManifestId !== journal.base.manifestId ||
    manifest.previousManifestDigest !== journal.base.manifestDigest ||
    manifest.previousPublicationDigest !== journal.base.publicationDigest ||
    manifest.recoveryRead.id !== journal.recoveryRead.id ||
    manifest.recoveryRead.startLba !== journal.recoveryRead.startLba ||
    manifest.recoveryRead.sectorCount !== journal.recoveryRead.sectorCount ||
    manifest.recoveryRead.outcome !== "recovered" ||
    manifest.journalDigest !== journal.journalDigest ||
    canonicalPublicationJson(manifest.protectedRanges) !==
      canonicalPublicationJson(protectedRanges)
  ) {
    throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
  }
}

async function verifyProtectedBytes(input: {
  imagePath: string;
  imageIdentity: string;
  imageSizeBytes: number;
  journal: DvdRecoveryJournalMetadata;
}): Promise<readonly ("before" | "after")[]> {
  const descriptor = await open(
    input.imagePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await descriptor.stat({ bigint: true });
    const named = await lstat(input.imagePath, { bigint: true });
    if (
      !stat.isFile() || named.isSymbolicLink() ||
      stat.dev !== named.dev || stat.ino !== named.ino ||
      `${stat.dev}:${stat.ino}` !== input.imageIdentity ||
      stat.size !== BigInt(input.imageSizeBytes)
    ) {
      throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
    }
    const states: Array<"before" | "after"> = [];
    for (const range of input.journal.protectedRanges) {
      const bytes = Buffer.alloc(range.byteCount);
      const read = await descriptor.read(
        bytes,
        0,
        bytes.length,
        range.startByte,
      );
      if (read.bytesRead !== bytes.length) {
        throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
      }
      const digest = sha256(bytes);
      if (digest === range.beforeDigest) states.push("before");
      else if (digest === range.afterDigest) states.push("after");
      else throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
    }
    return states;
  } finally {
    await descriptor.close();
  }
}

function recoveryStorageProtection(access: DataAccess) {
  const storage = access.dvdRecoveryStorage.readCurrent();
  const protection = storage?.facts.mutationProtection;
  if (storage?.status !== "supported" || protection?.status !== "verified") {
    throw new DvdRecoveryReconciliationFault("STORAGE_UNSUPPORTED");
  }
  return protection;
}

async function rollbackUncommittedBatch(input: {
  options: DvdRecoveryReconciliationOptions;
  ownership: ArchiveImageOwnershipHandle;
  imagePath: string;
  directory: string;
  current: CommittedDvdCheckpointEvidence;
  journal: Awaited<ReturnType<typeof readDvdRecoveryJournal>>;
  nextManifest: CommittedDvdRecoveryEvidence | null;
}): Promise<{ journal: "removed"; uncommittedManifest: "absent" | "removed" }> {
  const { options, ownership, current, journal, imagePath, directory } = input;
  const states = await verifyProtectedBytes({
    imagePath,
    imageIdentity: current.image.filesystemIdentity,
    imageSizeBytes: current.boundaryPublishedSizeBytes,
    journal: journal.metadata,
  });
  const protection = recoveryStorageProtection(options.access);
  const writer = options.atomicWriter ?? nodeDvdRecoveryAtomicWriter;
  if (writer.restoreVersion === undefined) {
    throw new DvdRecoveryReconciliationFault("STORAGE_UNSUPPORTED");
  }
  let actualProtection;
  try {
    actualProtection = writer.inspect({
      imagePath,
      filesystemIdentity: current.image.filesystemIdentity,
      ownershipDescriptor: ownership.descriptor,
    });
  } catch (cause) {
    throw new DvdRecoveryReconciliationFault("STORAGE_UNSUPPORTED", { cause });
  }
  if (
    actualProtection.contract !== protection.contract ||
    actualProtection.unitBytes !== protection.unitBytes ||
    actualProtection.memoryAlignmentBytes !== protection.memoryAlignmentBytes ||
    journal.metadata.protectedRanges.some((range) =>
      range.unitBytes !== protection.unitBytes)
  ) {
    throw new DvdRecoveryReconciliationFault("STORAGE_UNSUPPORTED");
  }
  await boundary(options, ownership, "rollback", "rolling_back", async () => {
    for (let index = 0; index < journal.metadata.protectedRanges.length; index += 1) {
      if (states[index] === "before") continue;
      const range = journal.metadata.protectedRanges[index]!;
      const bytes = journal.originalBytes.subarray(
        range.payloadOffset,
        range.payloadOffset + range.byteCount,
      );
      let written;
      try {
        written = writer.write({
          imagePath,
          filesystemIdentity: current.image.filesystemIdentity,
          ownershipDescriptor: ownership.descriptor,
          startByte: range.startByte,
          bytes,
          unitBytes: range.unitBytes,
        });
      } catch (cause) {
        throw new DvdRecoveryReconciliationFault(
          "CONSISTENCY_FAULT",
          { cause },
        );
      }
      if (
        written.bytesWritten !== range.byteCount ||
        written.unitBytes !== range.unitBytes
      ) {
        throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
      }
    }
  });
  await boundary(
    options,
    ownership,
    "rollback_sync",
    "rolling_back",
    async () => {
      try {
        const restored = writer.restoreVersion!({
          imagePath,
          filesystemIdentity: current.image.filesystemIdentity,
          ownershipDescriptor: ownership.descriptor,
          mtimeNs: current.image.mtimeNs,
        });
        if (restored.mtimeNs !== current.image.mtimeNs) {
          throw new Error("Image version differs after rollback");
        }
        await verifyDvdCheckpointImage(
          options.access.catalog.listOriginalDiscArchives({
            ids: [options.originalDiscArchiveId],
          })[0]!,
          current,
        );
      } catch (cause) {
        throw new DvdRecoveryReconciliationFault(
          "CONSISTENCY_FAULT",
          { cause },
        );
      }
    },
  );
  const nextManifestPath = join(
    directory,
    `recovery-manifest-${current.revision + 1}.json`,
  );
  let uncommittedManifest: "absent" | "removed" = "absent";
  await boundary(options, ownership, "cleanup", "cleaning_up", async () => {
    if (input.nextManifest !== null) {
      await unlink(nextManifestPath);
      uncommittedManifest = "removed";
      await syncDirectory(directory);
    }
    await unlink(join(directory, DVD_RECOVERY_JOURNAL_NAME));
    await syncDirectory(directory);
  });
  return { journal: "removed", uncommittedManifest };
}

async function runOwnedReconciliation(
  options: DvdRecoveryReconciliationOptions,
  ownership: ArchiveImageOwnershipHandle,
): Promise<{
  outcome: DvdRecoveryReconciliationOutcome;
  evidence: DvdRecoveryReconciliationEvidence;
}> {
  const archive = options.access.catalog.listOriginalDiscArchives({
    ids: [options.originalDiscArchiveId],
  })[0];
  const recovery = options.access.catalog.findArchiveRecovery(
    options.originalDiscArchiveId,
  );
  const header = options.access.catalog.findDvdArchiveEvidenceHeader(
    options.originalDiscArchiveId,
  );
  if (archive === undefined || recovery === null || header === null) {
    throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
  }
  const inspected = await boundary(
    options,
    ownership,
    "examine",
    "examining",
    async () => {
    const inspected = await readDvdCheckpointForReconciliation({
      originalsLibraryPath: options.originalsLibraryPath,
      archive,
      header,
      jobs: options.access.archiveJobs.listForArchive(archive.id),
      assertImageOwnership: ownership.assertOwned,
    });
    if (inspected === null) {
      throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
    }
      return inspected;
    },
  );
  const authoritative = inspected.currentEvidence;
  const authoritativeIdentity = checkpointIdentity(authoritative);
  const projectionBefore = projectedIdentity(header);
  const journalPath = join(
    inspected.directory,
    DVD_RECOVERY_JOURNAL_NAME,
  );
  const journal = inspected.journalPresent
    ? await readDvdRecoveryJournal(journalPath)
    : null;
  if (journal !== null) {
    const baseRevision = journal.metadata.base.revision;
    if (
      authoritative.revision !== baseRevision &&
      authoritative.revision !== baseRevision + 1
    ) {
      throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
    }
  }

  const uncommittedManifest = journal === null ||
      authoritative.revision === journal.metadata.base.revision
    ? await readDvdRecoveryManifestForReconciliation({
        directory: inspected.directory,
        initialEvidence: inspected.initialEvidence,
        previousEvidence: authoritative,
        revision: authoritative.revision + 1,
        assertImageOwnership: ownership.assertOwned,
      })
    : null;

  if (
    journal !== null &&
    authoritative.revision === journal.metadata.base.revision
  ) {
    if (!sameCheckpoint(authoritativeIdentity, projectionBefore)) {
      throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
    }
    assertJournalBase(
      journal.metadata,
      authoritative,
      options.originalDiscArchiveId,
    );
    if (uncommittedManifest !== null) {
      assertJournalCommit(journal.metadata, uncommittedManifest);
    }
    const cleanup = await rollbackUncommittedBatch({
      options,
      ownership,
      imagePath: archive.archivePath,
      directory: inspected.directory,
      current: authoritative,
      journal,
      nextManifest: uncommittedManifest,
    });
    return {
      outcome: "rolled_back",
      evidence: {
        authoritativeCheckpoint: authoritativeIdentity,
        databaseProjectionBefore: projectionBefore,
        databaseProjectionAfter: projectionBefore,
        ...cleanup,
      },
    };
  }

  if (journal === null && uncommittedManifest !== null) {
    if (
      !sameCheckpoint(authoritativeIdentity, projectionBefore) ||
      uncommittedManifest.recoveryRead.outcome !== "failed"
    ) {
      throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
    }
    try {
      await verifyDvdCheckpointImage(archive, authoritative);
    } catch (cause) {
      throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT", { cause });
    }
    await boundary(options, ownership, "cleanup", "cleaning_up", async () => {
      await unlink(join(
        inspected.directory,
        `recovery-manifest-${uncommittedManifest.revision}.json`,
      ));
      await syncDirectory(inspected.directory);
    });
    return {
      outcome: "rolled_back",
      evidence: {
        authoritativeCheckpoint: authoritativeIdentity,
        databaseProjectionBefore: projectionBefore,
        databaseProjectionAfter: projectionBefore,
        journal: "absent",
        uncommittedManifest: "removed",
      },
    };
  }

  if (journal !== null) {
    if (!("recoveryRead" in authoritative)) {
      throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
    }
    if (inspected.previousEvidence === null) {
      throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
    }
    assertJournalBase(
      journal.metadata,
      inspected.previousEvidence,
      options.originalDiscArchiveId,
    );
    assertJournalCommit(journal.metadata, authoritative);
  }
  if (
    journal === null &&
    "recoveryRead" in authoritative &&
    authoritative.journalDigest !== null &&
    !sameCheckpoint(authoritativeIdentity, projectionBefore)
  ) {
    throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
  }
  try {
    await verifyDvdCheckpointImage(archive, authoritative);
  } catch (cause) {
    throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT", { cause });
  }
  let projectionAfter = projectionBefore;
  let projected = false;
  if (!sameCheckpoint(authoritativeIdentity, projectionBefore)) {
    if (
      !("recoveryRead" in authoritative) ||
      authoritative.revision !== projectionBefore.revision + 1 ||
      authoritative.previousManifestId !== projectionBefore.manifestId ||
      authoritative.previousManifestDigest !== projectionBefore.manifestDigest
    ) {
      throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
    }
    await boundary(options, ownership, "projection", "projecting", async () => {
      const next = options.access.dvdRecovery.reconcileCheckpoint({
        recoveryRead: authoritative.recoveryRead,
        manifest: authoritative,
      });
      projectionAfter = projectedIdentity(next);
      projected = true;
    });
    if (!sameCheckpoint(authoritativeIdentity, projectionAfter)) {
      throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
    }
  }
  let journalResult: "absent" | "removed" = "absent";
  if (journal !== null) {
    await boundary(options, ownership, "cleanup", "cleaning_up", async () => {
      await unlink(journalPath);
      await syncDirectory(inspected.directory);
    });
    journalResult = "removed";
  }
  return {
    outcome: projected
      ? "rolled_forward"
      : journalResult === "removed"
        ? "cleaned_up"
        : "already_consistent",
    evidence: {
      authoritativeCheckpoint: authoritativeIdentity,
      databaseProjectionBefore: projectionBefore,
      databaseProjectionAfter: projectionAfter,
      journal: journalResult,
      uncommittedManifest: "absent",
    },
  };
}

export async function reconcileDvdRecoveryCheckpoint(
  options: DvdRecoveryReconciliationOptions,
): Promise<{
  outcome: DvdRecoveryReconciliationOutcome;
  evidence: DvdRecoveryReconciliationEvidence;
}> {
  try {
    options.assertClaim?.();
    const ownership = options.archiveImageOwnership ??
      defaultArchiveImageOwnership;
    const archive = options.access.catalog.listOriginalDiscArchives({
      ids: [options.originalDiscArchiveId],
    })[0];
    if (archive === undefined) {
      throw new DvdRecoveryReconciliationFault("CONSISTENCY_FAULT");
    }
    const result = await ownership.withWriter({
      archiveId: archive.id,
      imagePath: archive.archivePath,
      originalsLibraryPath: options.originalsLibraryPath,
      signal: options.signal ?? new AbortController().signal,
      task: (handle) => runOwnedReconciliation(options, handle),
    });
    const recovery = options.access.catalog.findArchiveRecovery(
      options.originalDiscArchiveId,
    );
    const staleWork = recovery?.work;
    if (
      options.releaseRecoveryWork !== false &&
      staleWork?.status === "claimed" &&
      staleWork.claimedBy !== null &&
      staleWork.claimToken !== null &&
      staleWork.claimedAt !== null
    ) {
      options.access.archiveRecoveryWork.release({
        ...staleWork,
        status: "claimed",
        claimedBy: staleWork.claimedBy,
        claimToken: staleWork.claimToken,
        claimedAt: staleWork.claimedAt,
      });
    }
    return result;
  } catch (cause) {
    if (cause instanceof DvdRecoveryReconciliationFault) throw cause;
    if (cause instanceof ArchiveImageOwnershipError) {
      throw new DvdRecoveryReconciliationFault(cause.code, { cause });
    }
    throw new DvdRecoveryReconciliationFault(
      "CONSISTENCY_FAULT",
      { cause },
    );
  }
}
