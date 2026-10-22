import {
  DomainInvariantError,
  DvdCheckpointReadFault,
  type DataAccess,
  type DvdTitleDamageAssessmentRecord,
  type DvdTitleIdentityReviewSet,
  type OriginalDiscArchiveId,
  type RecordDvdTitleDamageMappingInput,
} from "@rip-dvd/data-access";
import type {
  ArchiveImageOwnership,
  ArchiveImageOwnershipHandle,
} from "@rip-dvd/worker-runtime";

interface DvdTitleDamageAssessmentRequest {
  access: Pick<
    DataAccess,
    "catalog" | "dvdStructuralAssessments" | "dvdTitleDamageAssessments"
  >;
  archiveImageOwnership: Pick<ArchiveImageOwnership, "withConsistentRead">;
  originalDiscArchiveId: OriginalDiscArchiveId;
  originalsLibraryPath: string;
  signal: AbortSignal;
  mapSource(input: {
    checkpoint: DvdTitleIdentityReviewSet["checkpoint"];
    titleIdentity: DvdTitleIdentityReviewSet;
    structuralAssessmentIdentity: string;
    descriptor: ArchiveImageOwnershipHandle["descriptor"];
    signal: AbortSignal;
  }): Promise<readonly RecordDvdTitleDamageMappingInput[]>;
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

export async function assessDvdTitleDamageAtCheckpoint(
  input: DvdTitleDamageAssessmentRequest,
): Promise<DvdTitleDamageAssessmentRecord> {
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
      const titleIdentity = input.access.catalog
        .readDvdTitleIdentityReviewSet(archive.id);
      const structural = input.access.dvdStructuralAssessments.inspect(
        archive.id,
      );
      if (
        before === null || titleIdentity === null ||
        structural.state !== "current" ||
        structural.currentAssessmentIdentity === null
      ) {
        throw new DomainInvariantError(
          "Title Damage Assessment requires current checkpoint, title, and structural evidence",
        );
      }
      const mappings = await input.mapSource({
        checkpoint: titleIdentity.checkpoint,
        titleIdentity,
        structuralAssessmentIdentity: structural.currentAssessmentIdentity,
        descriptor: handle.descriptor,
        signal: handle.signal,
      });
      handle.assertOwned();
      const after = input.access.catalog.findDvdArchiveEvidenceHeader(
        archive.id,
      );
      const currentTitleIdentity = input.access.catalog
        .readDvdTitleIdentityReviewSet(archive.id);
      const currentStructural = input.access.dvdStructuralAssessments.inspect(
        archive.id,
      );
      if (
        after === null || !sameCheckpoint(before, after) ||
        currentTitleIdentity?.reviewSetIdentity !==
          titleIdentity.reviewSetIdentity ||
        currentStructural.state !== "current" ||
        currentStructural.currentAssessmentIdentity !==
          structural.currentAssessmentIdentity
      ) {
        throw new DvdCheckpointReadFault(
          "DVD_EVIDENCE_CHANGED_DURING_READ",
        );
      }
      return input.access.dvdTitleDamageAssessments.record({
        originalDiscArchiveId: archive.id,
        checkpoint: titleIdentity.checkpoint,
        titleIdentityReviewSetIdentity: titleIdentity.reviewSetIdentity,
        structuralAssessmentIdentity: structural.currentAssessmentIdentity,
        titles: mappings,
      });
    },
  });
}
