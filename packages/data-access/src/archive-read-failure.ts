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
  return (hostStatus >= 0x01 && hostStatus <= 0x12) || hostStatus === 0x14;
}

function isDriverTransportFailure(driverStatus: number): boolean {
  return driverStatus === 0x01 ||
    driverStatus === 0x02 ||
    driverStatus === 0x04 ||
    driverStatus === 0x06;
}

function isTargetSenseCompletion(
  evidence: ArchiveReadFailureScsiEvidence,
): boolean {
  return evidence.scsiStatus === 0x02 &&
    evidence.hostStatus === 0 &&
    (evidence.driverStatus === 0 || evidence.driverStatus === 0x08) &&
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
  if (
    evidence.senseKey === 0x03 &&
    evidence.asc === 0x11 &&
    (evidence.ascq === 0x00 ||
      evidence.ascq === 0x01 ||
      evidence.ascq === 0x02 ||
      evidence.ascq === 0x05 ||
      evidence.ascq === 0x06)
  ) {
    return "recognized_medium_error";
  }
  if (evidence.senseKey === 0x04) {
    return "hardware_error";
  }
  if (
    evidence.senseKey === 0x07 ||
    (evidence.senseKey === 0x05 &&
      evidence.asc === 0x6f &&
      evidence.ascq !== null &&
      evidence.ascq <= 0x05)
  ) {
    return "protection_error";
  }
  return "unknown";
}

export function isArchiveReadFailureEvidenceConsistent(
  evidence: ArchiveReadFailureClassificationEvidence,
): boolean {
  return evidence.category === "unknown" ||
    classifyArchiveReadFailureEvidence(evidence) === evidence.category;
}
