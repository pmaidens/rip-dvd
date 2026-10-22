import type {
  ArchiveRecoveryId,
  ArchiveRecoveryWork,
  EncodeJobId,
  EncodeJobStatus,
  OriginalDiscArchiveId,
} from "./types.js";
import { DomainInvariantError } from "./errors.js";

export const ENCODE_WORK_CONFLICT = {
  code: "ENCODE_WORK_CONFLICT",
  message:
    "Archive Recovery and queued or running Encode Jobs cannot use the same Original Disc Archive.",
} as const;

export interface EncodeWorkConflictCurrent {
  archiveRecovery: {
    id: ArchiveRecoveryId;
    originalDiscArchiveId: OriginalDiscArchiveId;
    work: ArchiveRecoveryWork | null;
  };
  encodeJobs: readonly {
    id: EncodeJobId;
    status: EncodeJobStatus;
  }[];
}

export class EncodeWorkConflictError extends DomainInvariantError {
  readonly code = ENCODE_WORK_CONFLICT.code;
  readonly blockingReasons = [{
    code: ENCODE_WORK_CONFLICT.code,
    message: ENCODE_WORK_CONFLICT.message,
  }] as const;

  constructor(readonly current: EncodeWorkConflictCurrent) {
    super(ENCODE_WORK_CONFLICT.message);
    this.name = "EncodeWorkConflictError";
  }
}
