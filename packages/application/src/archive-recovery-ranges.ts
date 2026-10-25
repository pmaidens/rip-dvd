import {
  DvdCheckpointReadFault,
  DomainInvariantError,
  RecordNotFoundError,
  type ArchiveRecovery,
  type DataAccess,
  type DvdArchiveRecoveryRangeEvidence,
  type DvdArchiveRecoverySourceRange,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError,
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

import { visibleArchiveRecovery } from "./archive-recovery-view.js";

export class InvalidArchiveRecoveryRangesInputError extends Error {}

export type ArchiveRecoverySourceRange = DvdArchiveRecoverySourceRange;

function safeProduct(left: number, right: number): number {
  const value = left * right;
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

function currentPassProgress(
  recovery: ArchiveRecovery,
  observations: DvdArchiveRecoveryRangeEvidence["currentPassObservations"],
  nowMs: number,
) {
  const work = recovery.work;
  if (work === null) return null;
  const startedAtMs = work.passStartedAt?.getTime() ?? null;
  const passIsActive = recovery.status === "running" &&
    work.status === "claimed";
  const lastCompletedPass = recovery.passHistory.at(-1);
  const completedPass = lastCompletedPass?.passNumber === work.passNumber
    ? lastCompletedPass
    : undefined;
  const elapsedEndMs = passIsActive
    ? nowMs
    : completedPass?.completedAtMs ?? work.updatedAt.getTime();
  const initialSectorCount = work.passInitialUnrecoveredSectorCount;
  const remainingSectorCount = initialSectorCount === null
    ? null
    : initialSectorCount - observations.count;
  if (remainingSectorCount !== null && remainingSectorCount < 0) {
    throw new DomainInvariantError(
      "Archive Recovery pass observations exceed its starting extent",
    );
  }
  let completionEstimate:
    | "unknown"
    | {
        scope: "current_pass";
        minimumRemainingMs: number;
        maximumRemainingMs: number;
        observationCount: number;
      } = "unknown";
  if (
    passIsActive &&
    startedAtMs !== null && remainingSectorCount !== null &&
    remainingSectorCount === 0
  ) {
    completionEstimate = {
      scope: "current_pass",
      minimumRemainingMs: 0,
      maximumRemainingMs: 0,
      observationCount: observations.count,
    };
  } else if (
    passIsActive &&
    startedAtMs !== null && remainingSectorCount !== null &&
    observations.count >= 2 &&
    observations.positiveIntervalCount === observations.count &&
    observations.minimumIntervalMs !== null &&
    observations.maximumIntervalMs !== null &&
    observations.lastObservedAt !== null
  ) {
    const currentObservationMs = Math.max(
      0,
      nowMs - observations.lastObservedAt.getTime(),
    );
    const maximumObservedMs = Math.max(
      observations.maximumIntervalMs,
      currentObservationMs,
    );
    completionEstimate = {
      scope: "current_pass",
      minimumRemainingMs: safeProduct(
        remainingSectorCount,
        observations.minimumIntervalMs,
      ),
      maximumRemainingMs: safeProduct(
        remainingSectorCount,
        maximumObservedMs,
      ),
      observationCount: observations.count,
    };
  }
  return {
    number: work.passNumber,
    direction: work.passDirection,
    cursorLba: work.passCursorLba,
    startedAt: work.passStartedAt,
    elapsedMs: startedAtMs === null
      ? null
      : Math.max(0, elapsedEndMs - startedAtMs),
    initialUnrecoveredSectorCount: initialSectorCount,
    recoveredSectorCount: work.passRecoveredSectorCount,
    observedSectorCount: observations.count,
    remainingSectorCount,
    completionEstimate,
  };
}

export function presentArchiveRecoveryRangeEvidence(
  evidence: DvdArchiveRecoveryRangeEvidence,
  nowMs = Date.now(),
) {
  const skippedUntestedSectorCount = evidence.checkpoint
    .unrecoveredSourceRanges
    .filter(({ classification }) => classification === "skipped_untested")
    .reduce((total, range) => total + range.sectorCount, 0);
  const individuallyFailedSectorCount = evidence.checkpoint
    .unrecoveredSourceRanges
    .filter(({ classification }) => classification === "individually_failed")
    .reduce((total, range) => total + range.sectorCount, 0);
  const passHistory = evidence.recovery.passHistory;
  const completedPassCount = passHistory.at(-1)?.passNumber ?? 0;
  return {
    recovery: visibleArchiveRecovery(evidence.recovery),
    checkpoint: {
      revision: evidence.checkpoint.currentManifestRevision,
      manifestId: evidence.checkpoint.currentManifestId,
      manifestDigest: evidence.checkpoint.currentManifestDigest,
    },
    progress: {
      acceptedExtentSectorCount:
        evidence.checkpoint.acceptedEndLbaExclusive,
      skippedUntestedSectorCount,
      individuallyFailedSectorCount,
      recoveredSectorCount: evidence.recoveredSectorCount,
      unresolvedSectorCount:
        skippedUntestedSectorCount + individuallyFailedSectorCount,
      currentPass: currentPassProgress(
        evidence.recovery,
        evidence.currentPassObservations,
        nowMs,
      ),
    },
    history: {
      passes: {
        items: passHistory,
        completedPassCount,
        truncated: passHistory.length > 0 &&
          passHistory[0]!.passNumber > 1,
      },
      transitions: {
        items: evidence.transitions.items.map((observation) => ({
          checkpointRevision: observation.checkpointRevision,
          startLba: observation.startLba,
          fromClassification: observation.fromClassification,
          toClassification: observation.outcome === "recovered"
            ? "recovered" as const
            : "individually_failed" as const,
          observedAt: observation.observedAt,
        })),
        totalCount: evidence.transitions.totalCount,
        truncated: evidence.transitions.truncated,
      },
    },
    ranges: evidence.ranges,
    rangeOffset: evidence.rangeOffset,
    rangeCount: evidence.rangeCount,
  };
}

interface ArchiveRecoveryRangesCursor {
  archiveRecoveryId: string;
  originalDiscArchiveId: string;
  checkpointRevision: number;
  manifestId: string;
  manifestDigest: string;
  offset: number;
}

function encodeCursor(cursor: ArchiveRecoveryRangesCursor): string {
  return Buffer.from(JSON.stringify([
    "dvd-recovery-ranges-page-v1",
    cursor.archiveRecoveryId,
    cursor.originalDiscArchiveId,
    cursor.checkpointRevision,
    cursor.manifestId,
    cursor.manifestDigest,
    cursor.offset,
  ])).toString("base64url");
}

function parseCursor(
  value: string | undefined,
): ArchiveRecoveryRangesCursor | null {
  if (value === undefined) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!Array.isArray(decoded) || decoded.length !== 7) throw new Error();
    const [
      kind,
      archiveRecoveryId,
      originalDiscArchiveId,
      checkpointRevision,
      manifestId,
      manifestDigest,
      offset,
    ] = decoded;
    if (
      kind !== "dvd-recovery-ranges-page-v1" ||
      typeof archiveRecoveryId !== "string" ||
      typeof originalDiscArchiveId !== "string" ||
      typeof checkpointRevision !== "number" ||
      !Number.isSafeInteger(checkpointRevision) || checkpointRevision < 1 ||
      typeof manifestId !== "string" ||
      typeof manifestDigest !== "string" ||
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) || offset < 1
    ) {
      throw new Error();
    }
    const cursor = {
      archiveRecoveryId,
      originalDiscArchiveId,
      checkpointRevision,
      manifestId,
      manifestDigest,
      offset,
    };
    if (encodeCursor(cursor) !== value) throw new Error();
    return cursor;
  } catch {
    throw new InvalidArchiveRecoveryRangesInputError(
      "Invalid Archive Recovery range cursor.",
    );
  }
}

export async function inspectArchiveRecoveryRanges(
  access: DataAccess,
  archiveRecoveryId: string,
  options: { limit?: number; cursor?: string } = {},
  archiveImageOwnership: ArchiveImageOwnership = defaultArchiveImageOwnership,
) {
  if (
    archiveRecoveryId.length === 0 || archiveRecoveryId.length > 256 ||
    (options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 1 ||
        options.limit > 100)) ||
    (options.cursor !== undefined &&
      (options.cursor.length === 0 || options.cursor.length > 2_048))
  ) {
    throw new InvalidArchiveRecoveryRangesInputError(
      "Invalid Archive Recovery range arguments.",
    );
  }
  const cursor = parseCursor(options.cursor);
  const rangeLimit = options.limit ?? 20;
  const recovery = access.catalog.findArchiveRecoveryById(
    archiveRecoveryId as ArchiveRecovery["id"],
  );
  if (recovery === null) {
    throw new RecordNotFoundError("Archive Recovery", archiveRecoveryId);
  }
  const unavailable = (
    reason: string,
    current: ReturnType<typeof presentArchiveRecoveryRangeEvidence> | null =
      null,
  ) => ({
    schemaVersion: 1,
    archiveRecoveryId,
    originalDiscArchiveId: recovery.originalDiscArchiveId,
    available: false,
    unavailableReason: reason,
    recovery: current?.recovery ?? visibleArchiveRecovery(recovery),
    checkpoint: current?.checkpoint ?? null,
    progress: current?.progress ?? null,
    history: current?.history ?? null,
    ranges: null,
    rangeOffset: null,
    rangeCount: null,
    truncated: false,
    complete: false,
    nextCursor: null,
  });
  let presented;
  let cursorIsStale = false;
  try {
    const read = await access.withDvdCurrentCheckpoint(
      recovery.originalDiscArchiveId as OriginalDiscArchiveId,
      archiveImageOwnership,
      async ({ checkpoint, assertOwned }) => {
        const cursorMatchesCheckpoint = cursor === null ||
          cursor.archiveRecoveryId === archiveRecoveryId &&
            cursor.originalDiscArchiveId ===
              recovery.originalDiscArchiveId &&
            cursor.checkpointRevision ===
              checkpoint.currentManifestRevision &&
            cursor.manifestId === checkpoint.currentManifestId &&
            cursor.manifestDigest === checkpoint.currentManifestDigest;
        const evidence = access.readConsistentSnapshot((snapshot) =>
          snapshot.catalog.readDvdArchiveRecoveryRangeEvidence(
            recovery.id,
            {
              rangeOffset: cursorMatchesCheckpoint
                ? cursor?.offset ?? 0
                : 0,
              rangeLimit,
            },
          )
        );
        if (
          evidence === null ||
          evidence.checkpoint.currentManifestId !==
            checkpoint.currentManifestId ||
          evidence.checkpoint.currentManifestRevision !==
            checkpoint.currentManifestRevision ||
          evidence.checkpoint.currentManifestDigest !==
            checkpoint.currentManifestDigest
        ) {
          throw new DomainInvariantError(
            "Archive Recovery range projection is not current",
          );
        }
        assertOwned();
        return {
          cursorIsStale: !cursorMatchesCheckpoint,
          presented: presentArchiveRecoveryRangeEvidence(evidence),
        };
      },
    );
    if (read === null) return unavailable("DVD_EVIDENCE_NOT_RECORDED");
    presented = read.presented;
    cursorIsStale = read.cursorIsStale;
  } catch (error) {
    return unavailable(
      error instanceof DvdCheckpointReadFault ||
          error instanceof ArchiveImageOwnershipError
        ? error.code
        : "DVD_RECOVERY_RANGE_INSPECTION_UNAVAILABLE",
    );
  }
  if (cursorIsStale) {
    return unavailable("DVD_RECOVERY_RANGE_CURSOR_STALE", presented);
  }
  const offset = presented.rangeOffset;
  if (cursor !== null && presented.ranges.length === 0) {
    if (offset < presented.rangeCount) {
      throw new DomainInvariantError(
        "Archive Recovery range page is incomplete",
      );
    }
    throw new InvalidArchiveRecoveryRangesInputError(
      "Archive Recovery range cursor is outside the range map.",
    );
  }
  const ranges = presented.ranges;
  const nextOffset = offset + ranges.length;
  const complete = nextOffset === presented.rangeCount;
  return {
    schemaVersion: 1,
    archiveRecoveryId,
    originalDiscArchiveId: recovery.originalDiscArchiveId,
    available: true,
    unavailableReason: null,
    recovery: presented.recovery,
    checkpoint: presented.checkpoint,
    progress: presented.progress,
    history: presented.history,
    ranges,
    rangeOffset: offset,
    rangeCount: presented.rangeCount,
    truncated: !complete,
    complete,
    nextCursor: complete
      ? null
      : encodeCursor({
          archiveRecoveryId,
          originalDiscArchiveId: recovery.originalDiscArchiveId,
          checkpointRevision: presented.checkpoint.revision,
          manifestId: presented.checkpoint.manifestId,
          manifestDigest: presented.checkpoint.manifestDigest,
          offset: nextOffset,
        }),
  };
}
