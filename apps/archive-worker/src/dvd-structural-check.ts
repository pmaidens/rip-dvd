import {
  DvdCheckpointReadFault,
  type DataAccess,
  type DvdStructuralCheckpoint,
  type DvdStructuralCheckKind,
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

function blockerCheckKind(field: string): DvdStructuralCheckKind {
  if (/(?:NAV|PCI|DSI|VOBU|PGC|cell|domain)/i.test(field)) {
    return "dvd_navigation";
  }
  if (/(?:title|VTS)/i.test(field)) {
    return "title_enumeration";
  }
  return "filesystem_structure";
}

function findingsFromDecision(
  checkpoint: DvdStructuralCheckpoint,
  decision: DvdFullExtentMetadataDecision,
): readonly DvdStructuralFindingInput[] {
  const blocker = decision.blockers[0];
  if (blocker?.reason === "local_failure") {
    throw new Error("DVD structural metadata check failed locally");
  }
  const blockedKind = blocker === undefined
    ? null
    : blockerCheckKind(blocker.field);
  return ([
    "filesystem_structure",
    "dvd_navigation",
    "title_enumeration",
  ] as const).map((checkKind) => {
    const outcome = blocker === undefined
      ? decision.impact === "listed_checks_agree"
        ? "valid" as const
        : "indeterminate" as const
      : checkKind === blockedKind
        ? blocker.reason === "contradiction"
          ? "invalid" as const
          : "indeterminate" as const
        : "not_run" as const;
    const reason = outcome === "valid"
      ? null
      : blocker === undefined
        ? {
          code: "UNPROVED_STRUCTURAL_EXTENT",
          message: "Source evidence leaves structural coverage unresolved.",
        }
        : outcome === "not_run"
          ? {
            code: "PREREQUISITE_STRUCTURAL_CHECK_FAILED",
            message: "A prerequisite structural check did not complete.",
          }
          : blocker.reason === "contradiction"
            ? {
              code: "STRUCTURAL_CONTRADICTION",
              message: "Readable structural claims disagree.",
            }
            : blocker.reason === "work_bound"
              ? {
                code: "STRUCTURAL_CHECK_LIMIT_REACHED",
                message: "The structural check reached its work limit.",
              }
              : {
                code: "STRUCTURAL_LAYOUT_UNSUPPORTED",
                message: "The structural layout is not supported.",
              };
    return {
      checkKind,
      policyVersion: decision.policyVersion,
      testedExtent: outcome === "not_run"
        ? null
        : {
          startLba: 0,
          endLbaExclusive: checkpoint.acceptedEndLbaExclusive,
        },
      outcome,
      reason,
      evidenceReference:
        `dvd-structural-profile:${checkpoint.manifestDigest}:${checkKind}`,
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
  checker = createNodeDvdStructuralChecker(),
  originalDiscArchiveId,
}: {
  access: DataAccess;
  archiveImageOwnership?: ArchiveImageOwnership;
  checker?: DvdStructuralChecker;
  originalDiscArchiveId: OriginalDiscArchiveId;
}) {
  let checkpoint = checkpointFromHeader(access, originalDiscArchiveId);
  try {
    const archive = access.catalog.listOriginalDiscArchives({
      ids: [originalDiscArchiveId],
    })[0];
    if (archive === undefined || archive.archivePath === null) {
      throw new DvdStructuralCheckUnavailableError(
        "STRUCTURAL_ARCHIVE_UNAVAILABLE",
      );
    }
    const checked = await access.assessDvdStructure(
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
          imageFilesystemIdentity: manifest.image.filesystemIdentity,
          imagePath: archive.archivePath!,
          unrecoveredSourceRanges: manifest.unrecoveredSourceRanges,
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
    return { outcome: "completed" as const, ...checked };
  } catch (error) {
    if (error instanceof DvdStructuralCheckUnavailableError) throw error;
    return access.dvdStructuralAssessments.recordFailed({
      checkpoint,
      reason: failureReason(error),
    });
  }
}
