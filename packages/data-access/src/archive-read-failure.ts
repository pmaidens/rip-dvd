import type { ArchiveReadFailureCategory } from "./types.js";

export interface ArchiveReadFailureScsiEvidence {
  scsiStatus: number | null;
  hostStatus: number | null;
  driverStatus: number | null;
  senseKey: number | null;
  asc: number | null;
  ascq: number | null;
}

export interface ArchiveReadFailureClassificationEvidence
  extends ArchiveReadFailureScsiEvidence {
  category: ArchiveReadFailureCategory;
}

export type ArchiveReadFailureEvidenceClassification =
  | ArchiveReadFailureCategory
  | "recognized_medium_error";

function isHostTransportFailure(hostStatus: number): boolean {
  return hostStatus !== 0;
}

function isDriverTransportFailure(driverStatus: number): boolean {
  const baseStatus = driverStatus & 0x0f;
  return baseStatus === 0x01 ||
    baseStatus === 0x02 ||
    baseStatus === 0x04 ||
    baseStatus === 0x06;
}

function isTargetSenseCompletion(
  evidence: ArchiveReadFailureScsiEvidence,
): boolean {
  return evidence.scsiStatus !== null &&
    (evidence.scsiStatus & 0xfe) === 0x02 &&
    evidence.hostStatus === 0 &&
    evidence.driverStatus !== null &&
    ((evidence.driverStatus & 0x0f) === 0 ||
      (evidence.driverStatus & 0x0f) === 0x08) &&
    evidence.senseKey !== null &&
    evidence.asc !== null &&
    evidence.ascq !== null;
}

export function classifyArchiveReadFailureEvidence(
  evidence: ArchiveReadFailureScsiEvidence,
): ArchiveReadFailureEvidenceClassification {
  if (
    evidence.scsiStatus === null ||
    evidence.hostStatus === null ||
    evidence.driverStatus === null
  ) {
    return "unknown";
  }
  if (
    isHostTransportFailure(evidence.hostStatus) ||
    (evidence.hostStatus === 0 &&
      isDriverTransportFailure(evidence.driverStatus))
  ) {
    return "transport_error";
  }
  if (!isTargetSenseCompletion(evidence)) {
    return "unknown";
  }
  if (evidence.senseKey === 0x02) {
    return "not_ready";
  }
  if (evidence.senseKey === 0x06) {
    return "unit_attention";
  }
  if (evidence.senseKey === 0x03) {
    return "recognized_medium_error";
  }
  if (evidence.senseKey === 0x04) {
    return "hardware_error";
  }
  if (
    evidence.senseKey === 0x07 ||
    (evidence.senseKey === 0x05 &&
      evidence.asc === 0x6f &&
      evidence.ascq !== null)
  ) {
    return "protection_error";
  }
  return "unknown";
}

export function isArchiveReadFailureEvidenceConsistent(
  evidence: ArchiveReadFailureClassificationEvidence,
): boolean {
  if (evidence.category === "out_of_range") {
    return isTargetSenseCompletion(evidence) &&
      evidence.senseKey === 0x05 &&
      evidence.asc === 0x21 &&
      evidence.ascq === 0x00;
  }
  return evidence.category === "unknown" ||
    classifyArchiveReadFailureEvidence(evidence) === evidence.category;
}
