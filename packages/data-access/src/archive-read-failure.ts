import type { ArchiveReadFailureCategory } from "./types.js";

export interface ArchiveReadFailureClassificationEvidence {
  category: ArchiveReadFailureCategory;
  scsiStatus: number | null;
  hostStatus: number | null;
  driverStatus: number | null;
  senseKey: number | null;
  asc: number | null;
  ascq: number | null;
}

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
  evidence: ArchiveReadFailureClassificationEvidence,
): boolean {
  return evidence.scsiStatus === 0x02 &&
    evidence.hostStatus === 0 &&
    (evidence.driverStatus === 0 || evidence.driverStatus === 0x08) &&
    evidence.senseKey !== null &&
    evidence.asc !== null &&
    evidence.ascq !== null;
}

export function isArchiveReadFailureEvidenceConsistent(
  evidence: ArchiveReadFailureClassificationEvidence,
): boolean {
  switch (evidence.category) {
    case "unknown":
      return true;
    case "not_ready":
      return isTargetSenseCompletion(evidence) && evidence.senseKey === 0x02;
    case "unit_attention":
      return isTargetSenseCompletion(evidence) && evidence.senseKey === 0x06;
    case "hardware_error":
      return isTargetSenseCompletion(evidence) && evidence.senseKey === 0x04;
    case "transport_error":
      return evidence.scsiStatus !== null &&
        evidence.hostStatus !== null &&
        evidence.driverStatus !== null &&
        (isHostTransportFailure(evidence.hostStatus) ||
          (evidence.hostStatus === 0 &&
            isDriverTransportFailure(evidence.driverStatus)));
    case "protection_error":
      return isTargetSenseCompletion(evidence) &&
        (evidence.senseKey === 0x07 ||
          (evidence.senseKey === 0x05 &&
            evidence.asc === 0x6f &&
            evidence.ascq !== null &&
            evidence.ascq <= 0x05));
  }
}
