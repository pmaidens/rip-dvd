import {
  DvdCheckpointReadFault,
  type DataAccess,
  type DvdStructuralCheckpoint,
  type DvdStructuralFindingInput,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  ArchiveImageOwnershipError,
  defaultArchiveImageOwnership,
  type ArchiveImageOwnership,
} from "@rip-dvd/worker-runtime";

export interface DvdStructuralChecker {
  check(input: {
    checkpoint: DvdStructuralCheckpoint;
    descriptor: number;
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

function failureReason(error: unknown) {
  if (
    error instanceof DvdCheckpointReadFault ||
    error instanceof ArchiveImageOwnershipError
  ) {
    return {
      code: error.code,
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
  checker,
  originalDiscArchiveId,
}: {
  access: DataAccess;
  archiveImageOwnership?: ArchiveImageOwnership;
  checker: DvdStructuralChecker;
  originalDiscArchiveId: OriginalDiscArchiveId;
}) {
  let checkpoint = checkpointFromHeader(access, originalDiscArchiveId);
  try {
    const checked = await access.withDvdInitialCheckpointRead(
      originalDiscArchiveId,
      archiveImageOwnership,
      async (manifest, handle) => {
        checkpoint = {
          originalDiscArchiveId,
          manifestId: manifest.id,
          manifestRevision: manifest.revision,
          manifestDigest: manifest.manifestDigest,
          acceptedEndLbaExclusive: manifest.acceptedEndLbaExclusive,
        };
        const findings = await checker.check({
          checkpoint,
          descriptor: handle.descriptor,
          signal: handle.signal,
          assertStable: () => handle.assertOwned(),
        });
        handle.assertOwned();
        return findings;
      },
    );
    if (checked === null) {
      throw new DvdStructuralCheckUnavailableError(
        "UNSUPPORTED_EVIDENCE_FORMAT",
      );
    }
    const recorded = access.dvdStructuralAssessments.recordCompleted({
      checkpoint,
      findings: checked.result,
    });
    return { outcome: "completed" as const, ...recorded };
  } catch (error) {
    if (error instanceof DvdStructuralCheckUnavailableError) throw error;
    return access.dvdStructuralAssessments.recordFailed({
      checkpoint,
      reason: failureReason(error),
    });
  }
}
