import type { DvdArchiveEvidenceFormat } from "./types.js";

export const DVD_RECOVERY_EVIDENCE_FORMAT =
  "dvd-recovery-evidence-v1" as const;

export const DVD_RECOVERY_EVIDENCE_ADMISSION = {
  state: "closed",
  code: "DVD_RECOVERY_EVIDENCE_ADMISSION_CLOSED",
  message:
    "New-format DVD Archive Job admission is closed until the recovery and encoding workflow is complete.",
} as const;

export class DvdRecoveryEvidenceAdmissionClosedError extends Error {
  readonly code = DVD_RECOVERY_EVIDENCE_ADMISSION.code;
  readonly blockingReasons = [{
    code: DVD_RECOVERY_EVIDENCE_ADMISSION.code,
    message: DVD_RECOVERY_EVIDENCE_ADMISSION.message,
  }] as const;

  constructor() {
    super(DVD_RECOVERY_EVIDENCE_ADMISSION.message);
    this.name = "DvdRecoveryEvidenceAdmissionClosedError";
  }
}

export function assertDvdRecoveryEvidenceAdmissionAvailable(
  evidenceFormat: DvdArchiveEvidenceFormat | null | undefined,
): void {
  if (evidenceFormat === DVD_RECOVERY_EVIDENCE_FORMAT) {
    throw new DvdRecoveryEvidenceAdmissionClosedError();
  }
}
