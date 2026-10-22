import {
  createEncodeWorkConflictCurrent,
  dvdRecoveryEvidenceFormatForArchive,
  DvdRecoveryEvidenceEncodingUnavailableError,
  EncodeWorkConflictError,
  type ConsistentReadAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

export function requireDvdRecoveryEvidenceEncodingAvailableForArchive(
  access: Pick<
    ConsistentReadAccess,
    "archiveJobs" | "catalog" | "encodeJobs"
  >,
  originalDiscArchiveId: OriginalDiscArchiveId,
): void {
  const recovery = access.catalog.findArchiveRecovery(originalDiscArchiveId);
  if (recovery !== null && recovery.work !== null) {
    const jobs = access.catalog.listDiscSelections({
      originalDiscArchiveId,
      includeHistorical: true,
    }).flatMap(({ id }) => access.encodeJobs.listForDiscSelection(id));
    throw new EncodeWorkConflictError(
      createEncodeWorkConflictCurrent(recovery, jobs),
    );
  }
  if (
    dvdRecoveryEvidenceFormatForArchive(
      access.catalog.findDvdArchiveEvidenceHeader(originalDiscArchiveId),
      access.archiveJobs.listForArchive(originalDiscArchiveId),
    ) !== null
  ) {
    throw new DvdRecoveryEvidenceEncodingUnavailableError();
  }
}
