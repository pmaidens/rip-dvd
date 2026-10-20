import {
  dvdRecoveryEvidenceFormatForArchive,
  DvdRecoveryEvidenceEncodingUnavailableError,
  type ConsistentReadAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

export function requireDvdRecoveryEvidenceEncodingAvailableForArchive(
  access: Pick<ConsistentReadAccess, "archiveJobs" | "catalog">,
  originalDiscArchiveId: OriginalDiscArchiveId,
): void {
  if (
    dvdRecoveryEvidenceFormatForArchive(
      access.catalog.findDvdArchiveEvidenceHeader(originalDiscArchiveId),
      access.archiveJobs.listForArchive(originalDiscArchiveId),
    ) !== null
  ) {
    throw new DvdRecoveryEvidenceEncodingUnavailableError();
  }
}
