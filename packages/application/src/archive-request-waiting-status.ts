import type { ArchiveRequestWaitingStatus } from "@rip-dvd/data-access";

export interface PresentedArchiveRequestWaitingStatus
  extends ArchiveRequestWaitingStatus {
  message: string;
}

export function describeArchiveRequestWaitingStatus(
  status: ArchiveRequestWaitingStatus | null,
): PresentedArchiveRequestWaitingStatus | null {
  if (status === null) {
    return null;
  }
  const message = {
    matching_disc_required:
      "Insert the disc matching the requested Original Disc Archive and wait for Disc Inspection to complete.",
    matching_inspection_incomplete:
      "A current Disc Inspection must complete before the inserted disc can be matched.",
    ready_for_archive_worker:
      "A completed Disc Inspection matches this Archive Request and is ready for the Archive Worker.",
  } satisfies Record<ArchiveRequestWaitingStatus["code"], string>;
  return { ...status, message: message[status.code] };
}
