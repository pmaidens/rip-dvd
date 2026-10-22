import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import {
  canonicalPublicationJson,
  DVD_RECOVERY_JOURNAL_METADATA_BYTES,
  DVD_RECOVERY_JOURNAL_PAYLOAD_BYTES,
  DVD_RECOVERY_JOURNAL_RESERVATION_BYTES,
  type CommittedDvdCheckpointEvidence,
  type DvdRecoveryProtectedRange,
} from "@rip-dvd/data-access";

export const DVD_RECOVERY_JOURNAL_NAME = "recovery-journal.bin";
export const DVD_RECOVERY_JOURNAL_MAGIC =
  "rip-dvd-recovery-journal-v1\n";

export interface DvdRecoveryJournalMetadata {
  version: "dvd-recovery-journal-v1";
  originalDiscArchiveId: string;
  image: { filesystemIdentity: string; mtimeNs: string; sizeBytes: number };
  base: {
    manifestId: string;
    revision: number;
    manifestDigest: string;
    publicationDigest: string;
    unrecoveredSourceRanges:
      CommittedDvdCheckpointEvidence["unrecoveredSourceRanges"];
  };
  recoveryRead: {
    id: string;
    startLba: number;
    sectorCount: 1;
    outcome: "recovered";
    sourceBytesDigest: string;
  };
  protectedRanges: readonly (DvdRecoveryProtectedRange & {
    payloadOffset: number;
  })[];
  journalDigest: string;
}

export class DvdRecoveryJournalFault extends Error {
  override readonly name = "DvdRecoveryJournalFault";
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createDvdRecoveryJournalDigest(
  metadata: Omit<DvdRecoveryJournalMetadata, "journalDigest">,
  originalBytes: Buffer,
): string {
  return sha256(Buffer.concat([
    Buffer.from("rip-dvd:recovery-journal:v1\0"),
    Buffer.from(canonicalPublicationJson(metadata)),
    originalBytes,
  ]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function assertMetadata(
  value: unknown,
): asserts value is DvdRecoveryJournalMetadata {
  if (!isRecord(value)) throw new DvdRecoveryJournalFault();
  const image = value.image;
  const base = value.base;
  const recoveryRead = value.recoveryRead;
  const protectedRanges = value.protectedRanges;
  if (
    value.version !== "dvd-recovery-journal-v1" ||
    typeof value.originalDiscArchiveId !== "string" ||
    value.originalDiscArchiveId.length === 0 ||
    value.originalDiscArchiveId.length > 128 ||
    !isRecord(image) ||
    typeof image.filesystemIdentity !== "string" ||
    !/^\d+:\d+$/.test(image.filesystemIdentity) ||
    typeof image.mtimeNs !== "string" ||
    !/^\d+$/.test(image.mtimeNs) ||
    !isPositiveInteger(image.sizeBytes) ||
    !isRecord(base) ||
    typeof base.manifestId !== "string" ||
    base.manifestId.length === 0 ||
    base.manifestId.length > 256 ||
    !isPositiveInteger(base.revision) ||
    !isDigest(base.manifestDigest) ||
    !isDigest(base.publicationDigest) ||
    !Array.isArray(base.unrecoveredSourceRanges) ||
    !isRecord(recoveryRead) ||
    typeof recoveryRead.id !== "string" ||
    recoveryRead.id.length === 0 ||
    recoveryRead.id.length > 256 ||
    !Number.isSafeInteger(recoveryRead.startLba) ||
    Number(recoveryRead.startLba) < 0 ||
    recoveryRead.sectorCount !== 1 ||
    recoveryRead.outcome !== "recovered" ||
    !isDigest(recoveryRead.sourceBytesDigest) ||
    !Array.isArray(protectedRanges) ||
    protectedRanges.length === 0 ||
    !isDigest(value.journalDigest)
  ) {
    throw new DvdRecoveryJournalFault();
  }
  if (base.unrecoveredSourceRanges.some((range) =>
    !isRecord(range) ||
    !Number.isSafeInteger(range.startLba) || Number(range.startLba) < 0 ||
    !isPositiveInteger(range.sectorCount) ||
    (range.classification !== "skipped_untested" &&
      range.classification !== "individually_failed")
  )) {
    throw new DvdRecoveryJournalFault();
  }
  let expectedPayloadOffset = 0;
  let unitBytes: number | null = null;
  for (const range of protectedRanges) {
    if (
      !isRecord(range) ||
      !Number.isSafeInteger(range.startByte) || Number(range.startByte) < 0 ||
      !isPositiveInteger(range.byteCount) ||
      !isPositiveInteger(range.unitBytes) ||
      range.byteCount !== range.unitBytes ||
      Number(range.startByte) % Number(range.unitBytes) !== 0 ||
      range.payloadOffset !== expectedPayloadOffset ||
      !isDigest(range.beforeDigest) ||
      !isDigest(range.afterDigest) ||
      Number(range.startByte) + Number(range.byteCount) > image.sizeBytes ||
      (unitBytes !== null && unitBytes !== range.unitBytes)
    ) {
      throw new DvdRecoveryJournalFault();
    }
    unitBytes = Number(range.unitBytes);
    expectedPayloadOffset += Number(range.byteCount);
  }
  if (expectedPayloadOffset > DVD_RECOVERY_JOURNAL_PAYLOAD_BYTES) {
    throw new DvdRecoveryJournalFault();
  }
}

export async function readDvdRecoveryJournal(
  path: string,
): Promise<{
  metadata: DvdRecoveryJournalMetadata;
  originalBytes: Buffer;
}> {
  let descriptor;
  try {
    descriptor = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await descriptor.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      !before.isFile() || named.isSymbolicLink() ||
      before.dev !== named.dev || before.ino !== named.ino ||
      before.size !== BigInt(DVD_RECOVERY_JOURNAL_RESERVATION_BYTES)
    ) {
      throw new DvdRecoveryJournalFault();
    }
    const bytes = Buffer.alloc(DVD_RECOVERY_JOURNAL_RESERVATION_BYTES);
    const read = await descriptor.read(bytes, 0, bytes.length, 0);
    const after = await descriptor.stat({ bigint: true });
    if (
      read.bytesRead !== bytes.length || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    ) {
      throw new DvdRecoveryJournalFault();
    }
    const magic = Buffer.from(DVD_RECOVERY_JOURNAL_MAGIC);
    const headerPrefixBytes = magic.length + 4 + 32;
    if (!bytes.subarray(0, magic.length).equals(magic)) {
      throw new DvdRecoveryJournalFault();
    }
    const metadataLength = bytes.readUInt32BE(magic.length);
    if (
      metadataLength < 2 ||
      headerPrefixBytes + metadataLength > DVD_RECOVERY_JOURNAL_METADATA_BYTES
    ) {
      throw new DvdRecoveryJournalFault();
    }
    const metadataBytes = bytes.subarray(
      headerPrefixBytes,
      headerPrefixBytes + metadataLength,
    );
    if (
      !bytes.subarray(magic.length + 4, headerPrefixBytes)
        .equals(Buffer.from(sha256(metadataBytes), "hex"))
    ) {
      throw new DvdRecoveryJournalFault();
    }
    const raw: unknown = JSON.parse(metadataBytes.toString("utf8"));
    assertMetadata(raw);
    if (canonicalPublicationJson(raw) !== metadataBytes.toString("utf8")) {
      throw new DvdRecoveryJournalFault();
    }
    const payloadBytes = raw.protectedRanges.reduce(
      (count, range) => count + range.byteCount,
      0,
    );
    const originalBytes = Buffer.from(bytes.subarray(
      DVD_RECOVERY_JOURNAL_METADATA_BYTES,
      DVD_RECOVERY_JOURNAL_METADATA_BYTES + payloadBytes,
    ));
    const { journalDigest, ...digestInput } = raw;
    if (
      journalDigest !==
        createDvdRecoveryJournalDigest(digestInput, originalBytes)
    ) {
      throw new DvdRecoveryJournalFault();
    }
    return { metadata: raw, originalBytes };
  } catch (cause) {
    if (cause instanceof DvdRecoveryJournalFault) throw cause;
    throw new DvdRecoveryJournalFault(undefined, { cause });
  } finally {
    await descriptor?.close();
  }
}
