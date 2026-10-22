import {
  DomainInvariantError,
  DvdCheckpointReadFault,
  type DataAccess,
  type DvdTitleIdentityObservationInput,
  type DvdTitleIdentityReviewSet,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import type {
  ArchiveImageOwnership,
  ArchiveImageOwnershipHandle,
} from "@rip-dvd/worker-runtime";

interface DvdTitleIdentityObservationRequest {
  access: Pick<DataAccess, "catalog">;
  archiveImageOwnership: Pick<ArchiveImageOwnership, "withConsistentRead">;
  originalDiscArchiveId: OriginalDiscArchiveId;
  originalsLibraryPath: string;
  signal: AbortSignal;
  observe(input: {
    checkpoint: {
      manifestId: string;
      manifestRevision: number;
      manifestDigest: string;
    };
    descriptor: ArchiveImageOwnershipHandle["descriptor"];
    signal: AbortSignal;
  }): Promise<readonly DvdTitleIdentityObservationInput[]>;
}

function sameCheckpoint(
  left: {
    currentManifestId: string;
    currentManifestRevision: number;
    currentManifestDigest: string;
  },
  right: {
    currentManifestId: string;
    currentManifestRevision: number;
    currentManifestDigest: string;
  },
) {
  return left.currentManifestId === right.currentManifestId &&
    left.currentManifestRevision === right.currentManifestRevision &&
    left.currentManifestDigest === right.currentManifestDigest;
}

/**
 * Runs a title-evidence producer inside the archive-wide stable-read interval,
 * revalidates the committed checkpoint after image I/O, and only then records
 * the immutable observation set. The producer and its scheduling belong to
 * the structural/title assessment slices that consume this boundary; new
 * evidence-format Archive Job admission remains closed.
 */
export async function observeDvdTitleIdentitiesAtCheckpoint(
  input: DvdTitleIdentityObservationRequest,
): Promise<DvdTitleIdentityReviewSet> {
  const archive = input.access.catalog.listOriginalDiscArchives({
    ids: [input.originalDiscArchiveId],
  })[0];
  if (archive === undefined) {
    throw new DomainInvariantError("Original Disc Archive was not found");
  }
  return input.archiveImageOwnership.withConsistentRead({
    archiveId: archive.id,
    imagePath: archive.archivePath,
    originalsLibraryPath: input.originalsLibraryPath,
    signal: input.signal,
    task: async (handle) => {
      handle.assertOwned();
      const before = input.access.catalog.findDvdArchiveEvidenceHeader(
        archive.id,
      );
      if (before === null) {
        throw new DomainInvariantError(
          "Title Identity observations require a new-format DVD evidence checkpoint",
        );
      }
      const checkpoint = {
        manifestId: before.currentManifestId,
        manifestRevision: before.currentManifestRevision,
        manifestDigest: before.currentManifestDigest,
      };
      const observations = await input.observe({
        checkpoint,
        descriptor: handle.descriptor,
        signal: handle.signal,
      });
      handle.assertOwned();
      const after = input.access.catalog.findDvdArchiveEvidenceHeader(
        archive.id,
      );
      if (after === null || !sameCheckpoint(before, after)) {
        throw new DvdCheckpointReadFault(
          "DVD_EVIDENCE_CHANGED_DURING_READ",
        );
      }
      return input.access.catalog.recordDvdTitleIdentityObservations({
        originalDiscArchiveId: archive.id,
        checkpoint,
        observations,
      });
    },
  });
}
