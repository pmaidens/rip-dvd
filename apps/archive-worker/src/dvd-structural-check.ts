import { createHash } from "node:crypto";
import {
  canonicalPublicationJson,
  createDvdStructuralAssessment,
  DVD_STRUCTURAL_CHECK_KINDS,
  DvdCheckpointReadFault,
  StaleDvdStructuralCheckpointError,
  type DataAccess,
  type DvdStructuralCheckpoint,
  type DvdStructuralFindingInput,
  type DvdUnrecoveredSourceRange,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError,
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";
import {
  createNodeDvdFullExtentMetadataValidator,
  structuralEvidenceObservations,
  type DvdFullExtentMetadataDecision,
  type DvdFullExtentMetadataValidator,
} from "./dvd-full-extent-validator.js";

export interface DvdStructuralChecker {
  check(input: {
    checkpoint: DvdStructuralCheckpoint;
    descriptor: number;
    imageFilesystemIdentity: string;
    imagePath: string;
    unrecoveredSourceRanges: readonly DvdUnrecoveredSourceRange[];
    signal: AbortSignal;
    assertStable(): void;
  }): Promise<readonly DvdStructuralFindingInput[]>;
}

export class DvdStructuralCheckUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function checkpointFromHeader(
  access: DataAccess,
  originalDiscArchiveId: OriginalDiscArchiveId,
): DvdStructuralCheckpoint {
  const header = access.catalog.findDvdArchiveEvidenceHeader(
    originalDiscArchiveId,
  );
  if (header === null) {
    throw new DvdStructuralCheckUnavailableError(
      "STRUCTURAL_CHECKPOINT_UNAVAILABLE",
    );
  }
  return {
    originalDiscArchiveId,
    manifestId: header.currentManifestId,
    manifestRevision: header.currentManifestRevision,
    manifestDigest: header.currentManifestDigest,
    acceptedEndLbaExclusive: header.acceptedEndLbaExclusive,
  };
}

function findingsFromDecision(
  checkpoint: DvdStructuralCheckpoint,
  decision: DvdFullExtentMetadataDecision,
): readonly DvdStructuralFindingInput[] {
  const blocker = decision.blockers[0];
  if (blocker?.reason === "local_failure") {
    throw new Error("DVD structural metadata check failed locally");
  }
  return DVD_STRUCTURAL_CHECK_KINDS.map((checkKind) => {
    const evidence = decision.structuralChecks.find(
      (item) => item.checkKind === checkKind,
    );
    const blocked = blocker !== undefined &&
      decision.blockedCheckKind === checkKind;
    const outcome = evidence === undefined || evidence.execution === "not_run"
      ? "not_run" as const
      : blocked && blocker.reason === "contradiction"
        ? "invalid" as const
        : blocked || evidence.execution === "interrupted" ||
            evidence.testedExtent === null || evidence.hasUnprovedDependencies
          ? "indeterminate" as const
          : "valid" as const;
    const reason = outcome === "valid"
      ? null
      : outcome === "not_run"
        ? {
          code: "STRUCTURAL_CHECK_NOT_RUN",
          message: "The structural check did not run.",
        }
        : blocked && blocker.reason === "contradiction"
          ? {
            code: "STRUCTURAL_CONTRADICTION",
            message: "Readable structural claims disagree.",
          }
          : blocked && blocker.reason === "work_bound"
            ? {
              code: "STRUCTURAL_CHECK_LIMIT_REACHED",
              message: "The structural check reached its work limit.",
            }
            : blocked && blocker.reason === "unsupported_layout"
              ? {
                code: "STRUCTURAL_LAYOUT_UNSUPPORTED",
                message: "The structural layout is not supported.",
              }
              : evidence?.testedExtent === null
                ? {
                  code: "STRUCTURAL_EXTENT_NOT_OBSERVED",
                  message: "The check produced no physical extent evidence.",
                }
                : {
                  code: "UNPROVED_STRUCTURAL_EXTENT",
                  message: "Source evidence leaves structural coverage unresolved.",
                };
    const evidenceDigest = createHash("sha256").update(canonicalPublicationJson({
      checkKind,
      execution: evidence?.execution ?? "not_run",
      testedExtent: evidence?.testedExtent ?? null,
      observations: structuralEvidenceObservations(
        decision.observations,
        checkKind,
      ),
      blocker: blocked ? blocker : null,
    })).digest("hex");
    return {
      checkKind,
      policyVersion: decision.policyVersion,
      testedExtent: outcome === "not_run"
        ? null
        : evidence?.testedExtent ?? null,
      outcome,
      reason,
      evidenceReference:
        `dvd-structural-profile:${checkpoint.manifestDigest}:${checkKind}:${evidenceDigest}`,
    };
  });
}

export function createNodeDvdStructuralChecker({
  metadataValidator = createNodeDvdFullExtentMetadataValidator(),
}: {
  metadataValidator?: DvdFullExtentMetadataValidator;
} = {}): DvdStructuralChecker {
  return {
    async check({
      assertStable,
      checkpoint,
      imageFilesystemIdentity,
      imagePath,
      signal,
      unrecoveredSourceRanges,
    }) {
      assertStable();
      const decision = await metadataValidator.validate({
        expectedByteCount: checkpoint.acceptedEndLbaExclusive * 2_048,
        imageFilesystemIdentity,
        imagePath,
        signal,
        unrecoveredSourceRanges,
      });
      assertStable();
      return findingsFromDecision(checkpoint, decision);
    },
  };
}

function failureReason(error: unknown) {
  if (
    error instanceof DvdCheckpointReadFault ||
    error instanceof ArchiveImageOwnershipError
  ) {
    return {
      code: "CONSISTENCY_FAULT",
      message: "The committed DVD checkpoint could not be read consistently.",
    };
  }
  if (error instanceof TypeError) {
    return {
      code: "STRUCTURAL_CHECK_RESULT_INVALID",
      message: "The structural check returned an invalid result.",
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      code: "STRUCTURAL_CHECK_ABORTED",
      message: "The structural check was interrupted.",
    };
  }
  return {
    code: "STRUCTURAL_CHECK_FAILED",
    message: "The structural check did not complete.",
  };
}

export async function runDvdStructuralCheck({
  access,
  archiveImageOwnership = defaultArchiveImageOwnership,
  checker = createNodeDvdStructuralChecker(),
  originalDiscArchiveId,
}: {
  access: DataAccess;
  archiveImageOwnership?: ArchiveImageOwnership;
  checker?: DvdStructuralChecker;
  originalDiscArchiveId: OriginalDiscArchiveId;
}) {
  checkpointFromHeader(access, originalDiscArchiveId);
  let attemptedCheckpoint: DvdStructuralCheckpoint | null = null;
  try {
    const checked = await access.assessDvdStructure(
      originalDiscArchiveId,
      archiveImageOwnership,
      async (manifest, handle, imagePath) => {
        const checkpoint = {
          originalDiscArchiveId,
          manifestId: manifest.id,
          manifestRevision: manifest.revision,
          manifestDigest: manifest.manifestDigest,
          acceptedEndLbaExclusive: manifest.acceptedEndLbaExclusive,
        };
        attemptedCheckpoint = checkpoint;
        try {
          const findings = await checker.check({
            checkpoint,
            descriptor: handle.descriptor,
            imageFilesystemIdentity: manifest.image.filesystemIdentity,
            imagePath,
            unrecoveredSourceRanges: manifest.unrecoveredSourceRanges,
            signal: handle.signal,
            assertStable: () => handle.assertOwned(),
          });
          createDvdStructuralAssessment({ checkpoint, findings });
          handle.assertOwned();
          return { outcome: "completed" as const, findings };
        } catch (error) {
          handle.assertOwned();
          return {
            outcome: "failed" as const,
            reason: failureReason(error),
          };
        }
      },
    );
    if (checked === null) {
      throw new DvdStructuralCheckUnavailableError(
        "UNSUPPORTED_EVIDENCE_FORMAT",
      );
    }
    return checked.outcome === "failed" ? checked.attempt : checked;
  } catch (error) {
    if (error instanceof DvdStructuralCheckUnavailableError) throw error;
    const reason = failureReason(error);
    if (attemptedCheckpoint !== null) {
      try {
        return access.dvdStructuralAssessments.recordFailed({
          checkpoint: attemptedCheckpoint,
          reason,
        });
      } catch (persistenceError) {
        if (!(persistenceError instanceof StaleDvdStructuralCheckpointError)) {
          throw persistenceError;
        }
        // A concurrently advanced checkpoint must not inherit this failure.
      }
    }
    return {
      outcome: "unavailable" as const,
      reason,
    };
  }
}
