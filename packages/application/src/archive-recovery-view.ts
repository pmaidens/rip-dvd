import {
  archiveRecoveryWorkIdentity,
  type ArchiveRecovery,
} from "@rip-dvd/data-access";

export function visibleArchiveRecovery(recovery: ArchiveRecovery) {
  return {
    ...recovery,
    work: recovery.work === null
      ? null
      : archiveRecoveryWorkIdentity(recovery.work),
  };
}
