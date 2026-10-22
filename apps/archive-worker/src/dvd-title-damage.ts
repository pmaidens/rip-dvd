import {
  DomainInvariantError,
  type DataAccess,
  type DvdCheckpointReadOwnership,
  type DvdTitleDamageAssessmentRecord,
  type DvdTitleIdentityReviewSet,
  type OriginalDiscArchiveId,
  type RecordDvdTitleDamageMappingInput,
} from "@rip-dvd/data-access";

interface DvdTitleDamageAssessmentRequest {
  access: Pick<DataAccess, "assessDvdTitleDamage">;
  archiveImageOwnership: DvdCheckpointReadOwnership;
  originalDiscArchiveId: OriginalDiscArchiveId;
  signal: AbortSignal;
  mapSource(input: {
    checkpoint: DvdTitleIdentityReviewSet["checkpoint"];
    titleIdentity: DvdTitleIdentityReviewSet;
    structuralAssessmentIdentity: string;
    descriptor: number;
    signal: AbortSignal;
  }): Promise<readonly RecordDvdTitleDamageMappingInput[]>;
}

export async function assessDvdTitleDamageAtCheckpoint(
  input: DvdTitleDamageAssessmentRequest,
): Promise<DvdTitleDamageAssessmentRecord> {
  const assessment = await input.access.assessDvdTitleDamage(
    input.originalDiscArchiveId,
    {
      withConsistentRead: (request) =>
        input.archiveImageOwnership.withConsistentRead({
          ...request,
          signal: AbortSignal.any([request.signal, input.signal]),
        }),
    },
    (evidence, handle) =>
      input.mapSource({
        ...evidence,
        descriptor: handle.descriptor,
        signal: handle.signal,
      }),
  );
  if (assessment === null) {
    throw new DomainInvariantError(
      "Title Damage Assessment requires a new-format DVD evidence checkpoint",
    );
  }
  return assessment;
}
