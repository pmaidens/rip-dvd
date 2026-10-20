import {
  DvdCheckpointReadFault, RecordNotFoundError,
  type DataAccess, type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError,
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

export class InvalidArchiveEvidenceInputError extends Error {}

interface EvidenceRevision {
  number: number;
  manifestId: string;
  manifestDigest: string;
  publicationDigest: string;
}

function parseCursor(value: string | undefined): unknown[] | null {
  if (value === undefined) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 7 || decoded[0] !== "dvd-evidence-page-v1" ||
      typeof decoded[1] !== "string" || !Number.isSafeInteger(decoded[2]) || decoded[2] < 1 ||
      typeof decoded[3] !== "string" || typeof decoded[4] !== "string" || typeof decoded[5] !== "string" ||
      !Number.isSafeInteger(decoded[6]) || decoded[6] < 1 ||
      Buffer.from(JSON.stringify(decoded)).toString("base64url") !== value) throw new Error();
    return decoded;
  } catch { throw new InvalidArchiveEvidenceInputError("Invalid archive evidence cursor."); }
}

export async function inspectArchiveEvidence(
  access: DataAccess,
  archiveId: string,
  options: { limit?: number; cursor?: string } = {},
  archiveImageOwnership: ArchiveImageOwnership = defaultArchiveImageOwnership,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(archiveId) ||
    (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)) ||
    (options.cursor !== undefined && (options.cursor.length === 0 || options.cursor.length > 2048))) {
    throw new InvalidArchiveEvidenceInputError("Invalid archive evidence arguments.");
  }
  const cursor = parseCursor(options.cursor);
  const archive = access.catalog.listOriginalDiscArchives({ ids: [archiveId as OriginalDiscArchiveId] })[0];
  if (!archive) throw new RecordNotFoundError("Original Disc Archive", archiveId);
  const unavailable = (reason: string, revision: EvidenceRevision | null = null) => ({
    schemaVersion: 1, originalDiscArchiveId: archiveId,
    available: false, unavailableReason: reason, recordedIntegrity: archive.integrity,
    revision, evidence: null, ranges: null, rangeOffset: null,
    truncated: false, complete: false, nextCursor: null,
  });
  let manifest;
  try {
    manifest = await access.readDvdInitialCheckpoint(
      archiveId as OriginalDiscArchiveId,
      archiveImageOwnership,
    );
  }
  catch (error) {
    return unavailable(
      error instanceof DvdCheckpointReadFault ||
        error instanceof ArchiveImageOwnershipError
        ? error.code
        : "DVD_EVIDENCE_PROJECTION_INVALID",
    );
  }
  if (manifest === null) return unavailable("DVD_EVIDENCE_NOT_RECORDED");
  const revision: EvidenceRevision = {
    number: manifest.revision, manifestId: manifest.id,
    manifestDigest: manifest.manifestDigest, publicationDigest: manifest.publicationDigest,
  };
  if (cursor !== null && (cursor[1] !== archiveId || cursor[2] !== revision.number ||
    cursor[3] !== revision.manifestId || cursor[4] !== revision.manifestDigest || cursor[5] !== revision.publicationDigest))
    return unavailable("DVD_EVIDENCE_CURSOR_STALE", revision);
  const offset = cursor === null ? 0 : Number(cursor[6]);
  const allRanges = manifest.unrecoveredSourceRanges;
  if (cursor !== null && offset >= allRanges.length)
    throw new InvalidArchiveEvidenceInputError("Archive evidence cursor is outside the range map.");
  const ranges = allRanges.slice(offset, offset + (options.limit ?? 20));
  const nextOffset = offset + ranges.length;
  const complete = nextOffset === allRanges.length;
  const classifications = { skipped_untested: 0, individually_failed: 0 };
  for (const range of allRanges) classifications[range.classification] += range.sectorCount;
  const unresolvedSectorCount = classifications.skipped_untested + classifications.individually_failed;
  return {
    schemaVersion: 1, originalDiscArchiveId: archiveId,
    available: true, unavailableReason: null, recordedIntegrity: archive.integrity, revision,
    evidence: {
      evidenceFormat: manifest.evidenceFormat, acceptedEndLbaExclusive: manifest.acceptedEndLbaExclusive,
      sectorSizeBytes: manifest.sectorSizeBytes, boundaryEvidence: manifest.boundaryEvidence,
      integrity: unresolvedSectorCount === 0 ? "clean_read" : "incomplete_read",
      classifications, skippedSectorCount: classifications.skipped_untested, unresolvedSectorCount,
      skippedPercentage: classifications.skipped_untested / manifest.acceptedEndLbaExclusive * 100,
      unresolvedPercentage: unresolvedSectorCount / manifest.acceptedEndLbaExclusive * 100,
      rangeCount: allRanges.length,
    },
    ranges, rangeOffset: offset, truncated: !complete, complete,
    nextCursor: complete ? null : Buffer.from(JSON.stringify([
      "dvd-evidence-page-v1", archiveId, revision.number, revision.manifestId,
      revision.manifestDigest, revision.publicationDigest, nextOffset,
    ])).toString("base64url"),
  };
}
