import { randomFillSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  DVD_RECOVERY_JOURNAL_RESERVATION_BYTES,
  DVD_RECOVERY_JOURNAL_PAYLOAD_BYTES,
  DVD_RECOVERY_ATOMIC_WRITE_CONTRACT,
  DVD_RECOVERY_STORAGE_PREFLIGHT_VERSION,
  type DataAccess,
  type DvdRecoveryMutationProtection,
  type DvdRecoveryNetworkCapabilityState,
  type DvdRecoveryStorageClass,
  type DvdRecoveryStoragePreflightFacts,
  type DvdRecoveryStoragePreflightInput,
  type DvdRecoveryStorageReasonCode,
} from "@rip-dvd/data-access";

const PREFLIGHT_WORKSPACE_PREFIX = ".rip-dvd-recovery-preflight-v1-";
const PREFLIGHT_WRITE_CHUNK_BYTES = 64 * 1_024;
const FLOCK_CONFLICT_EXIT_CODE = 75;

const LOCAL_FILESYSTEMS = new Map<bigint, string>([
  [0xef53n, "ext"],
  [0x58465342n, "xfs"],
  [0x9123683en, "btrfs"],
]);

const NETWORK_FILESYSTEMS = new Map<bigint, string>([
  [0x6969n, "nfs"],
  [0x517bn, "smb"],
  [0xff534d42n, "cifs"],
  [0x01021997n, "9p"],
  [0x73757245n, "coda"],
]);

export type DvdRecoveryStoragePreflightStage =
  | "journal_reservation"
  | "journal_sync"
  | "directory_sync"
  | "image_sync"
  | "checkpoint_sync"
  | "checkpoint_replacement"
  | "writer_exclusion"
  | "cleanup";

export interface DvdRecoveryStorageInspection {
  filesystemType: string;
  storageClass: DvdRecoveryStorageClass;
  crossHostWriterExclusion: DvdRecoveryNetworkCapabilityState;
  disconnectionBehavior: DvdRecoveryNetworkCapabilityState;
}

export interface DvdRecoveryStoragePreflightDependencies {
  inspectStorage(path: string): DvdRecoveryStorageInspection;
  probeImage(path: string): {
    status: "supported" | "unsupported" | "capacity_insufficient";
    protection: DvdRecoveryMutationProtection;
  };
  verifyCrossProcessWriterExclusion(lockPath: string): void;
  beforeStage?(stage: DvdRecoveryStoragePreflightStage): void;
}

class StoragePreflightFailure extends Error {
  constructor(readonly code: DvdRecoveryStorageReasonCode) {
    super(code);
  }
}

class StorageUnsupported extends Error {}

function probeNodeAtomicImage(path: string): ReturnType<
  DvdRecoveryStoragePreflightDependencies["probeImage"]
> {
  const probe = spawnSync(
    "/usr/local/bin/rip-dvd-recovery-atomic-probe",
    [path, String(DVD_RECOVERY_JOURNAL_PAYLOAD_BYTES)],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 4_096 },
  );
  if (probe.error !== undefined || probe.status !== 0) {
    throw new StoragePreflightFailure(
      probe.error !== undefined ? "STORAGE_INSPECTION_FAILED" : "IMAGE_SYNC_FAILED",
    );
  }
  const result = JSON.parse(probe.stdout) as Record<string, unknown>;
  if (result.status === "unsupported") {
    return {
      status: "unsupported",
      protection: {
        status: "unproven",
        contract: null,
        unitBytes: null,
        memoryAlignmentBytes: null,
      },
    };
  }
  if (
    (result.status !== "supported" && result.status !== "capacity_insufficient") ||
    typeof result.unitBytes !== "number" ||
    !Number.isSafeInteger(result.unitBytes) || result.unitBytes <= 0 ||
    typeof result.memoryAlignmentBytes !== "number" ||
    !Number.isSafeInteger(result.memoryAlignmentBytes) ||
    result.memoryAlignmentBytes <= 0 ||
    (result.status === "supported" &&
      result.unitBytes > DVD_RECOVERY_JOURNAL_PAYLOAD_BYTES)
  ) throw new StoragePreflightFailure("STORAGE_INSPECTION_FAILED");
  return {
    status: result.status,
    protection: {
      status: "verified",
      contract: DVD_RECOVERY_ATOMIC_WRITE_CONTRACT,
      unitBytes: result.unitBytes,
      memoryAlignmentBytes: result.memoryAlignmentBytes,
    },
  };
}

function normalizedFilesystemType(type: number | bigint): bigint {
  return BigInt.asUintN(32, BigInt(type));
}

function inspectNodeStorage(path: string): DvdRecoveryStorageInspection {
  const type = normalizedFilesystemType(statfsSync(path, { bigint: true }).type);
  const localName = LOCAL_FILESYSTEMS.get(type);
  if (localName !== undefined) {
    return {
      filesystemType: localName,
      storageClass: "local",
      crossHostWriterExclusion: "not_applicable",
      disconnectionBehavior: "not_applicable",
    };
  }
  const networkName = NETWORK_FILESYSTEMS.get(type);
  if (networkName !== undefined) {
    return {
      filesystemType: networkName,
      storageClass: "network",
      crossHostWriterExclusion: "unproven",
      disconnectionBehavior: "unproven",
    };
  }
  return {
    filesystemType: `linux-magic-0x${type.toString(16)}`,
    storageClass: "unknown",
    crossHostWriterExclusion: "unproven",
    disconnectionBehavior: "unproven",
  };
}

export function verifyNodeRecoveryWriterExclusion(lockPath: string): void {
  const firstDescriptor = openSync(
    lockPath,
    fsConstants.O_CREAT |
      fsConstants.O_RDWR |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  let secondDescriptor: number | null = null;
  try {
    secondDescriptor = openSync(
      lockPath,
      fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    );
    const first = spawnSync(
      "flock",
      [
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        String(FLOCK_CONFLICT_EXIT_CODE),
        "3",
      ],
      { stdio: ["ignore", "ignore", "ignore", firstDescriptor] },
    );
    if (first.error !== undefined || first.status !== 0) {
      throw first.error ?? new Error("Recovery writer lock was not acquired");
    }
    const competing = spawnSync(
      "flock",
      [
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        String(FLOCK_CONFLICT_EXIT_CODE),
        "3",
      ],
      { stdio: ["ignore", "ignore", "ignore", secondDescriptor] },
    );
    if (
      competing.error !== undefined ||
      competing.status !== FLOCK_CONFLICT_EXIT_CODE
    ) {
      throw competing.error ??
        new Error("Recovery writer lock did not exclude a competing process");
    }
  } finally {
    if (secondDescriptor !== null) closeSync(secondDescriptor);
    closeSync(firstDescriptor);
  }
}

const defaultDependencies: DvdRecoveryStoragePreflightDependencies = {
  inspectStorage: inspectNodeStorage,
  probeImage: probeNodeAtomicImage,
  verifyCrossProcessWriterExclusion: verifyNodeRecoveryWriterExclusion,
};

function initialFacts(
  inspection: DvdRecoveryStorageInspection,
): DvdRecoveryStoragePreflightFacts {
  return {
    filesystemType: inspection.filesystemType,
    storageClass: inspection.storageClass,
    mutationProtection: {
      status: "unproven",
      contract: null,
      unitBytes: null,
      memoryAlignmentBytes: null,
    },
    journalReservationBytes: DVD_RECOVERY_JOURNAL_RESERVATION_BYTES,
    journalPayloadBytes: DVD_RECOVERY_JOURNAL_PAYLOAD_BYTES,
    journalReservation: "not_tested",
    journalSynchronization: "not_tested",
    imageSynchronization: "not_tested",
    checkpointSynchronization: "not_tested",
    checkpointReplacement: "not_tested",
    directorySynchronization: "not_tested",
    crossProcessWriterExclusion: "not_tested",
    crossHostWriterExclusion: inspection.crossHostWriterExclusion,
    disconnectionBehavior: inspection.disconnectionBehavior,
  };
}

function failedResult(
  facts: DvdRecoveryStoragePreflightFacts,
  reasonCode: DvdRecoveryStorageReasonCode,
): DvdRecoveryStoragePreflightInput {
  return {
    contractVersion: DVD_RECOVERY_STORAGE_PREFLIGHT_VERSION,
    status: "failed_prerequisite",
    reasonCode,
    facts,
  };
}

function unsupportedResult(
  facts: DvdRecoveryStoragePreflightFacts,
): DvdRecoveryStoragePreflightInput {
  return {
    contractVersion: DVD_RECOVERY_STORAGE_PREFLIGHT_VERSION,
    status: "unsupported",
    reasonCode: "STORAGE_UNSUPPORTED",
    facts,
  };
}

function requireSafeRoot(path: string): string {
  const resolved = resolve(path);
  if (!isAbsolute(resolved) || Buffer.byteLength(resolved) > 4_096) {
    throw new Error("Originals Library path is invalid");
  }
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Originals Library must be a real directory");
  }
  return realpathSync(resolved);
}

function synchronizeDirectory(path: string): void {
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeSyncedFile(path: string, contents: Buffer): void {
  const descriptor = openSync(
    path,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < contents.length) {
      const written = writeSync(
        descriptor,
        contents,
        offset,
        contents.length - offset,
      );
      if (written <= 0) throw new Error("Recovery preflight write stalled");
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removePreflightWorkspace(path: string): void {
  for (const name of [
    "undo-journal.bin",
    "image-probe.bin",
    "checkpoint.current",
    "checkpoint.next",
    "writer.lock",
  ]) {
    try {
      unlinkSync(join(path, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  rmdirSync(path);
}

function runCapability(
  dependencies: DvdRecoveryStoragePreflightDependencies,
  stage: DvdRecoveryStoragePreflightStage,
  reasonCode: DvdRecoveryStorageReasonCode,
  facts: DvdRecoveryStoragePreflightFacts,
  fact: keyof Pick<
    DvdRecoveryStoragePreflightFacts,
    | "journalReservation"
    | "journalSynchronization"
    | "imageSynchronization"
    | "checkpointSynchronization"
    | "checkpointReplacement"
    | "directorySynchronization"
    | "crossProcessWriterExclusion"
  >,
  operation: () => void,
): void {
  try {
    dependencies.beforeStage?.(stage);
    operation();
    facts[fact] = "verified";
  } catch {
    facts[fact] = "failed";
    throw new StoragePreflightFailure(reasonCode);
  }
}

export function runDvdRecoveryStoragePreflight(
  originalsLibraryPath: string,
  dependencies: DvdRecoveryStoragePreflightDependencies = defaultDependencies,
): DvdRecoveryStoragePreflightInput {
  let root: string;
  let inspection: DvdRecoveryStorageInspection;
  try {
    root = requireSafeRoot(originalsLibraryPath);
    inspection = dependencies.inspectStorage(root);
  } catch {
    return failedResult(initialFacts({
      filesystemType: "unavailable",
      storageClass: "unknown",
      crossHostWriterExclusion: "unproven",
      disconnectionBehavior: "unproven",
    }), "STORAGE_INSPECTION_FAILED");
  }

  const facts = initialFacts(inspection);
  if (
    inspection.storageClass === "unknown" ||
    (inspection.storageClass === "network" &&
      (inspection.crossHostWriterExclusion !== "verified" ||
        inspection.disconnectionBehavior !== "verified"))
  ) {
    return unsupportedResult(facts);
  }

  let workspace: string | null = null;
  let result = failedResult(facts, "STORAGE_INSPECTION_FAILED");
  let journalDescriptor: number | null = null;
  try {
    runCapability(
      dependencies,
      "journal_reservation",
      "JOURNAL_RESERVATION_FAILED",
      facts,
      "journalReservation",
      () => {
        workspace = mkdtempSync(join(root, PREFLIGHT_WORKSPACE_PREFIX));
        chmodSync(workspace, 0o700);
        const journalPath = join(workspace, "undo-journal.bin");
        journalDescriptor = openSync(
          journalPath,
          fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_WRONLY |
            fsConstants.O_NOFOLLOW,
          0o600,
        );
        const chunk = Buffer.allocUnsafe(PREFLIGHT_WRITE_CHUNK_BYTES);
        let offset = 0;
        while (offset < DVD_RECOVERY_JOURNAL_RESERVATION_BYTES) {
          randomFillSync(chunk);
          const length = Math.min(
            chunk.length,
            DVD_RECOVERY_JOURNAL_RESERVATION_BYTES - offset,
          );
          const written = writeSync(
            journalDescriptor,
            chunk,
            0,
            length,
          );
          if (written <= 0) {
            throw new Error("Recovery journal reservation stalled");
          }
          offset += written;
        }
        if (
          fstatSync(journalDescriptor).size !==
            DVD_RECOVERY_JOURNAL_RESERVATION_BYTES
        ) {
          throw new Error("Recovery journal reservation is incomplete");
        }
      },
    );
    runCapability(
      dependencies,
      "journal_sync",
      "JOURNAL_SYNC_FAILED",
      facts,
      "journalSynchronization",
      () => fsyncSync(journalDescriptor!),
    );
    const reservedJournalDescriptor = journalDescriptor as number | null;
    if (reservedJournalDescriptor === null) {
      throw new StoragePreflightFailure("JOURNAL_RESERVATION_FAILED");
    }
    closeSync(reservedJournalDescriptor);
    journalDescriptor = null;
    const preflightWorkspace = workspace as string | null;
    if (preflightWorkspace === null) {
      throw new StoragePreflightFailure("JOURNAL_RESERVATION_FAILED");
    }

    runCapability(
      dependencies,
      "directory_sync",
      "DIRECTORY_SYNC_FAILED",
      facts,
      "directorySynchronization",
      () => synchronizeDirectory(preflightWorkspace),
    );

    try {
      dependencies.beforeStage?.("image_sync");
      const imageProbePath = join(preflightWorkspace, "image-probe.bin");
      writeSyncedFile(imageProbePath, Buffer.alloc(0));
      const probe = dependencies.probeImage(imageProbePath);
      facts.mutationProtection = probe.protection;
      if (probe.status === "unsupported") throw new StorageUnsupported();
      if (probe.status === "capacity_insufficient") {
        throw new StoragePreflightFailure("JOURNAL_CAPACITY_INSUFFICIENT");
      }
      facts.imageSynchronization = "verified";
    } catch (error) {
      if (error instanceof StorageUnsupported) throw error;
      if (error instanceof StoragePreflightFailure) {
        if (error.code === "IMAGE_SYNC_FAILED") facts.imageSynchronization = "failed";
        throw error;
      }
      facts.imageSynchronization = "failed";
      throw new StoragePreflightFailure("IMAGE_SYNC_FAILED");
    }

    const checkpointPath = join(preflightWorkspace, "checkpoint.current");
    const checkpointCandidatePath = join(
      preflightWorkspace,
      "checkpoint.next",
    );
    runCapability(
      dependencies,
      "checkpoint_sync",
      "CHECKPOINT_SYNC_FAILED",
      facts,
      "checkpointSynchronization",
      () => {
        writeSyncedFile(checkpointPath, Buffer.from("revision-0\n", "utf8"));
        writeSyncedFile(
          checkpointCandidatePath,
          Buffer.from("revision-1\n", "utf8"),
        );
      },
    );
    runCapability(
      dependencies,
      "checkpoint_replacement",
      "CHECKPOINT_REPLACEMENT_FAILED",
      facts,
      "checkpointReplacement",
      () => {
        renameSync(checkpointCandidatePath, checkpointPath);
        if (readFileSync(checkpointPath, "utf8") !== "revision-1\n") {
          throw new Error("Recovery checkpoint replacement was not observed");
        }
      },
    );
    runCapability(
      dependencies,
      "directory_sync",
      "DIRECTORY_SYNC_FAILED",
      facts,
      "directorySynchronization",
      () => synchronizeDirectory(preflightWorkspace),
    );
    runCapability(
      dependencies,
      "writer_exclusion",
      "WRITER_EXCLUSION_FAILED",
      facts,
      "crossProcessWriterExclusion",
      () => dependencies.verifyCrossProcessWriterExclusion(
        join(preflightWorkspace, "writer.lock"),
      ),
    );

    result = {
      contractVersion: DVD_RECOVERY_STORAGE_PREFLIGHT_VERSION,
      status: "supported",
      reasonCode: null,
      facts,
    };
  } catch (error) {
    result = error instanceof StorageUnsupported ? unsupportedResult(facts) : failedResult(
      facts,
      error instanceof StoragePreflightFailure
        ? error.code
        : "STORAGE_INSPECTION_FAILED",
    );
  } finally {
    if (journalDescriptor !== null) {
      try {
        closeSync(journalDescriptor);
      } catch {
        // The recorded stage already identifies the failed prerequisite.
      }
    }
    if (workspace !== null) {
      try {
        dependencies.beforeStage?.("cleanup");
        removePreflightWorkspace(workspace);
        synchronizeDirectory(root);
      } catch {
        result = failedResult(facts, "PREFLIGHT_CLEANUP_FAILED");
      }
    }
  }
  return result;
}

export function recordDvdRecoveryStoragePreflight(
  access: Pick<DataAccess, "dvdRecoveryStorage">,
  originalsLibraryPath: string,
  dependencies?: DvdRecoveryStoragePreflightDependencies,
) {
  return access.dvdRecoveryStorage.record(
    runDvdRecoveryStoragePreflight(originalsLibraryPath, dependencies),
  );
}
