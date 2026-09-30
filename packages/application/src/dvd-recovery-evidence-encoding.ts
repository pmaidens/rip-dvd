import {
  DvdRecoveryEvidenceEncodingUnavailableError,
  type ConsistentReadAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

export function requireDvdRecoveryEvidenceEncodingAvailableForArchive(
  access: Pick<ConsistentReadAccess, "catalog">,
  originalDiscArchiveId: OriginalDiscArchiveId,
): void {
  if (
    access.catalog.findDvdArchiveEvidenceHeader(originalDiscArchiveId) !== null
  ) {
    throw new DvdRecoveryEvidenceEncodingUnavailableError();
  }
}
