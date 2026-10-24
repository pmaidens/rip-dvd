import {
  DvdCheckpointReadFault,
  DomainInvariantError,
  RecordNotFoundError,
  type ArchiveRecovery,
  type DataAccess,
  type DvdArchiveRecoveryRangeEvidence,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError,
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

import { visibleArchiveRecovery } from "./archive-recovery-view.js";

export class InvalidArchiveRecoveryRangesInputError extends Error {}

export interface ArchiveRecoverySourceRange {
  startLba: number;
  sectorCount: number;
  classification:
    | "skipped_untested"
    | "individually_failed"
    | "recovered";
}

const HISTORY_LIMIT = 16;

function safeProduct(left: number, right: number): number {
  const value = left * right;
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

function compactRecoverySourceRanges(
  evidence: DvdArchiveRecoveryRangeEvidence,
): ArchiveRecoverySourceRange[] {
  const ranges: ArchiveRecoverySourceRange[] = [
    ...evidence.checkpoint.unrecoveredSourceRanges,
    ...evidence.observations
      .filter(({ outcome }) => outcome === "recovered")
      .map(({ startLba }) => ({
        startLba,
        sectorCount: 1,
        classification: "recovered" as const,
      })),
  ].sort((left, right) => left.startLba - right.startLba);
  return ranges.reduce<ArchiveRecoverySourceRange[]>((normalized, range) => {
    const previous = normalized.at(-1);
    const previousEnd = previous === undefined
      ? null
      : previous.startLba + previous.sectorCount;
    if (previousEnd !== null && range.startLba < previousEnd) {
      throw new DomainInvariantError(
        "DVD Archive Recovery source ranges overlap",
      );
    }
    if (
      previous !== undefined &&
      previousEnd === range.startLba &&
      previous.classification === range.classification
    ) {
      normalized[normalized.length - 1] = {
        ...previous,
        sectorCount: previous.sectorCount + range.sectorCount,
      };
    } else {
      normalized.push(range);
    }
    return normalized;
  }, []);
}

function currentPassProgress(
  recovery: ArchiveRecovery,
  observations: DvdArchiveRecoveryRangeEvidence["observations"],
  nowMs: number,
) {
  const work = recovery.work;
  if (work === null) return null;
  const startedAtMs = work.passStartedAt?.getTime() ?? null;
  const passObservations = startedAtMs === null
    ? []
    : observations.filter(({ observedAt }) =>
      observedAt.getTime() >= startedAtMs
    );
  const initialSectorCount = work.passInitialUnrecoveredSectorCount;
  const remainingSectorCount = initialSectorCount === null
    ? null
    : initialSectorCount - passObservations.length;
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
    recovery.status === "running" && work.status === "claimed" &&
    startedAtMs !== null && remainingSectorCount !== null &&
    remainingSectorCount === 0
  ) {
    completionEstimate = {
      scope: "current_pass",
      minimumRemainingMs: 0,
      maximumRemainingMs: 0,
      observationCount: passObservations.length,
    };
  } else if (
    recovery.status === "running" && work.status === "claimed" &&
    startedAtMs !== null && remainingSectorCount !== null &&
    passObservations.length >= 2
  ) {
    const completedAt = passObservations.map(({ observedAt }) =>
      observedAt.getTime()
    );
    const intervals = completedAt.map((timestamp, index) =>
      timestamp - (index === 0 ? startedAtMs : completedAt[index - 1]!)
    ).filter((duration) => duration > 0);
    if (intervals.length >= 2) {
      const minimumObservedMs = Math.min(...intervals);
      const currentObservationMs = Math.max(
        0,
        nowMs - completedAt.at(-1)!,
      );
      const maximumObservedMs = Math.max(
        ...intervals,
        currentObservationMs,
      );
      completionEstimate = {
        scope: "current_pass",
        minimumRemainingMs: safeProduct(
          remainingSectorCount,
          minimumObservedMs,
        ),
        maximumRemainingMs: safeProduct(
          remainingSectorCount,
          maximumObservedMs,
        ),
        observationCount: passObservations.length,
      };
    }
  }
  return {
    number: work.passNumber,
    direction: work.passDirection,
    cursorLba: work.passCursorLba,
    startedAt: work.passStartedAt,
    elapsedMs: startedAtMs === null ? null : Math.max(0, nowMs - startedAtMs),
    initialUnrecoveredSectorCount: initialSectorCount,
    recoveredSectorCount: work.passRecoveredSectorCount,
    observedSectorCount: passObservations.length,
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
  const recoveredSectorCount = evidence.observations
    .filter(({ outcome }) => outcome === "recovered").length;
  const meaningfulTransitions = evidence.observations.flatMap((observation) => {
    const toClassification = observation.outcome === "recovered"
      ? "recovered" as const
      : "individually_failed" as const;
    return observation.fromClassification === toClassification
      ? []
      : [{
          checkpointRevision: observation.checkpointRevision,
          startLba: observation.startLba,
          fromClassification: observation.fromClassification,
          toClassification,
          observedAt: observation.observedAt,
        }];
  });
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
      recoveredSectorCount,
      unresolvedSectorCount:
        skippedUntestedSectorCount + individuallyFailedSectorCount,
      currentPass: currentPassProgress(
        evidence.recovery,
        evidence.observations,
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
        items: meaningfulTransitions.slice(-HISTORY_LIMIT),
        totalCount: meaningfulTransitions.length,
        truncated: meaningfulTransitions.length > HISTORY_LIMIT,
      },
    },
    ranges: compactRecoverySourceRanges(evidence),
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
  try {
    const read = await access.withDvdCurrentCheckpoint(
      recovery.originalDiscArchiveId as OriginalDiscArchiveId,
      archiveImageOwnership,
      async ({ checkpoint, assertOwned }) => {
        const evidence = access.readConsistentSnapshot((snapshot) =>
          snapshot.catalog.readDvdArchiveRecoveryRangeEvidence(
            recovery.id,
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
        return presentArchiveRecoveryRangeEvidence(evidence);
      },
    );
    if (read === null) return unavailable("DVD_EVIDENCE_NOT_RECORDED");
    presented = read;
  } catch (error) {
    return unavailable(
      error instanceof DvdCheckpointReadFault ||
          error instanceof ArchiveImageOwnershipError
        ? error.code
        : "DVD_RECOVERY_RANGE_INSPECTION_UNAVAILABLE",
    );
  }
  if (
    cursor !== null &&
    (
      cursor.archiveRecoveryId !== archiveRecoveryId ||
      cursor.originalDiscArchiveId !== recovery.originalDiscArchiveId ||
      cursor.checkpointRevision !== presented.checkpoint.revision ||
      cursor.manifestId !== presented.checkpoint.manifestId ||
      cursor.manifestDigest !== presented.checkpoint.manifestDigest
    )
  ) {
    return unavailable("DVD_RECOVERY_RANGE_CURSOR_STALE", presented);
  }
  const offset = cursor?.offset ?? 0;
  if (cursor !== null && offset >= presented.ranges.length) {
    throw new InvalidArchiveRecoveryRangesInputError(
      "Archive Recovery range cursor is outside the range map.",
    );
  }
  const ranges = presented.ranges.slice(
    offset,
    offset + (options.limit ?? 20),
  );
  const nextOffset = offset + ranges.length;
  const complete = nextOffset === presented.ranges.length;
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
    rangeCount: presented.ranges.length,
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
