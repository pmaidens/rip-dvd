import type { DvdTitleDamageAssessment } from "@rip-dvd/data-access";

/** The same recorded assessment must retain its unknowns at admission and inspection. */
export function assessmentHasUnknownSourceImpact(assessment: Pick<DvdTitleDamageAssessment,
  "unknownTitleImpact" | "sourceContinuity" | "unattributedSourceContinuityRisk">): boolean {
  return assessment.unknownTitleImpact.unrecoveredSourceSectorCount > 0 ||
    assessment.unknownTitleImpact.reasons.length > 0 || assessment.sourceContinuity === null ||
    assessment.unattributedSourceContinuityRisk === null;
}
