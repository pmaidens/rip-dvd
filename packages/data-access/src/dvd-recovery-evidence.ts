import type { DvdArchiveEvidenceFormat } from "./types.js";

export const DVD_RECOVERY_EVIDENCE_FORMAT =
  "dvd-recovery-evidence-v1" as const;

export const DVD_RECOVERY_EVIDENCE_ADMISSION = {
  state: "closed",
  code: "DVD_RECOVERY_EVIDENCE_ADMISSION_CLOSED",
  message:
    "New-format DVD Archive Job admission is closed until the recovery and encoding workflow is complete.",
} as const;

export const DVD_RECOVERY_EVIDENCE_ENCODING = {
  code: "DVD_RECOVERY_EVIDENCE_ENCODING_UNAVAILABLE",
  message:
    "Encode Jobs are unavailable for dvd-recovery-evidence-v1 archives until damage acceptance and stable-source gates are complete.",
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

export class DvdRecoveryEvidenceEncodingUnavailableError extends Error {
  readonly code = DVD_RECOVERY_EVIDENCE_ENCODING.code;
  readonly blockingReasons = [{
    code: DVD_RECOVERY_EVIDENCE_ENCODING.code,
    message: DVD_RECOVERY_EVIDENCE_ENCODING.message,
  }] as const;

  constructor() {
    super(DVD_RECOVERY_EVIDENCE_ENCODING.message);
    this.name = "DvdRecoveryEvidenceEncodingUnavailableError";
  }
}

export function assertDvdRecoveryEvidenceAdmissionAvailable(
  evidenceFormat: DvdArchiveEvidenceFormat | null | undefined,
): void {
  if (evidenceFormat === DVD_RECOVERY_EVIDENCE_FORMAT) {
    throw new DvdRecoveryEvidenceAdmissionClosedError();
  }
}
