import { createHash } from "node:crypto";

import type { OriginalDiscArchiveId } from "./types.js";

export const DVD_STRUCTURAL_ASSESSMENT_POLICY_VERSION =
  "dvd-structural-assessment-v1" as const;

export const DVD_STRUCTURAL_CHECK_KINDS = [
  "filesystem_structure",
  "dvd_navigation",
  "title_enumeration",
] as const;

export const DVD_STRUCTURAL_FINDING_OUTCOMES = [
  "valid",
  "invalid",
  "indeterminate",
  "not_run",
] as const;

export type DvdStructuralCheckKind =
  (typeof DVD_STRUCTURAL_CHECK_KINDS)[number];
export type DvdStructuralFindingOutcome =
  (typeof DVD_STRUCTURAL_FINDING_OUTCOMES)[number];
export type DvdStructuralValidity = "valid" | "invalid" | "unknown";

export interface DvdStructuralCheckpoint {
  originalDiscArchiveId: OriginalDiscArchiveId;
  manifestId: string;
  manifestRevision: number;
  manifestDigest: string;
  acceptedEndLbaExclusive: number;
}

export interface DvdStructuralFindingInput {
  checkKind: DvdStructuralCheckKind;
  policyVersion: string;
  testedExtent: {
    startLba: number;
    endLbaExclusive: number;
    observedSectorCount: number;
  } | null;
  outcome: DvdStructuralFindingOutcome;
  reason: { code: string; message: string } | null;
  evidenceReference: string;
}

export interface DvdStructuralAssessment {
  id: string;
  policyVersion: typeof DVD_STRUCTURAL_ASSESSMENT_POLICY_VERSION;
  checkpoint: DvdStructuralCheckpoint;
  validity: DvdStructuralValidity;
  findings: readonly DvdStructuralFindingInput[];
}

export interface DvdStructuralAssessmentRecord
  extends DvdStructuralAssessment {
  createdAt: Date;
}

export type DvdStructuralCheckAttempt = {
  sequence: number;
  checkpoint: DvdStructuralCheckpoint;
  createdAt: Date;
} & (
  | {
    outcome: "completed";
    assessmentIdentity: string;
    findings: readonly DvdStructuralFindingInput[];
    reason: null;
  }
  | {
    outcome: "failed";
    assessmentIdentity: null;
    findings: null;
    reason: { code: string; message: string };
  }
);

export interface DvdStructuralAssessmentInspection {
  schemaVersion: 1;
  policyVersion: typeof DVD_STRUCTURAL_ASSESSMENT_POLICY_VERSION;
  originalDiscArchiveId: OriginalDiscArchiveId;
  state: "unavailable" | "pending" | "current" | "outdated";
  checkpoint: DvdStructuralCheckpoint | null;
  currentAssessmentIdentity: string | null;
  assessment: DvdStructuralAssessmentRecord | null;
  latestAttempt: DvdStructuralCheckAttempt | null;
  unavailableReasons: readonly { code: string; message: string }[];
}

export interface DvdStructuralAssessmentAccess {
  recordFailed(input: {
    checkpoint: DvdStructuralCheckpoint;
    reason: { code: string; message: string };
  }): DvdStructuralCheckAttempt & { outcome: "failed" };
  inspect(
    originalDiscArchiveId: OriginalDiscArchiveId,
  ): DvdStructuralAssessmentInspection;
}

function boundedText(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum;
}

export function validateDvdStructuralFailureReason(
  reason: { code: string; message: string },
): { code: string; message: string } {
  if (
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(reason.code) ||
    !boundedText(reason.message, 512)
  ) {
    throw new TypeError("Invalid DVD structural check failure reason");
  }
  return { ...reason };
}

function validateCheckpoint(
  checkpoint: DvdStructuralCheckpoint,
): DvdStructuralCheckpoint {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(
      checkpoint.originalDiscArchiveId,
    ) ||
    !boundedText(checkpoint.manifestId, 256) ||
    !Number.isSafeInteger(checkpoint.manifestRevision) ||
    checkpoint.manifestRevision < 1 ||
    !/^[a-f0-9]{64}$/.test(checkpoint.manifestDigest) ||
    !Number.isSafeInteger(checkpoint.acceptedEndLbaExclusive) ||
    checkpoint.acceptedEndLbaExclusive < 1
  ) {
    throw new TypeError("Invalid DVD structural assessment checkpoint");
  }
  return { ...checkpoint };
}

function validateFinding(
  finding: DvdStructuralFindingInput,
  acceptedEndLbaExclusive: number,
): DvdStructuralFindingInput {
  const extent = finding.testedExtent;
  const validExtent = extent !== null &&
    Number.isSafeInteger(extent.startLba) &&
    extent.startLba >= 0 &&
    Number.isSafeInteger(extent.endLbaExclusive) &&
    extent.endLbaExclusive > extent.startLba &&
    extent.endLbaExclusive <= acceptedEndLbaExclusive &&
    Number.isSafeInteger(extent.observedSectorCount) &&
    extent.observedSectorCount > 0 &&
    extent.observedSectorCount <=
      extent.endLbaExclusive - extent.startLba;
  const reason = finding.reason;
  if (reason !== null) {
    validateDvdStructuralFailureReason(reason);
  }
  if (
    !DVD_STRUCTURAL_CHECK_KINDS.includes(finding.checkKind) ||
    !DVD_STRUCTURAL_FINDING_OUTCOMES.includes(finding.outcome) ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(finding.policyVersion) ||
    !boundedText(finding.evidenceReference, 512) ||
    (finding.outcome === "not_run"
      ? extent !== null
      : extent !== null && !validExtent) ||
    (finding.outcome === "valid" && extent === null) ||
    (finding.outcome === "valid" ? reason !== null : reason === null)
  ) {
    throw new TypeError("Invalid DVD structural finding");
  }
  return {
    ...finding,
    testedExtent: extent === null ? null : { ...extent },
    reason: reason === null ? null : { ...reason },
  };
}

export function createDvdStructuralAssessment(input: {
  checkpoint: DvdStructuralCheckpoint;
  findings: readonly DvdStructuralFindingInput[];
}): DvdStructuralAssessment {
  const checkpoint = validateCheckpoint(input.checkpoint);
  const findingsByKind = new Map(input.findings.map((finding) => [
    finding.checkKind,
    validateFinding(finding, checkpoint.acceptedEndLbaExclusive),
  ]));
  if (
    input.findings.length !== DVD_STRUCTURAL_CHECK_KINDS.length ||
    findingsByKind.size !== DVD_STRUCTURAL_CHECK_KINDS.length
  ) {
    throw new TypeError("Every required DVD structural check must be recorded once");
  }
  const findings = DVD_STRUCTURAL_CHECK_KINDS.map((kind) => {
    const finding = findingsByKind.get(kind);
    if (finding === undefined) {
      throw new TypeError("Every required DVD structural check must be recorded once");
    }
    return finding;
  });
  const validity: DvdStructuralValidity = findings.some(
    ({ outcome }) => outcome === "invalid",
  )
    ? "invalid"
    : findings.every(({ outcome }) => outcome === "valid")
      ? "valid"
      : "unknown";
  const semanticInput = JSON.stringify([
    checkpoint.originalDiscArchiveId,
    checkpoint.manifestId,
    checkpoint.manifestRevision,
    checkpoint.manifestDigest,
    checkpoint.acceptedEndLbaExclusive,
    findings,
  ], (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
        Object.entries(value).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        ),
      )
      : value
  );
  const digest = createHash("sha256")
    .update("rip-dvd:dvd-structural-assessment:v1\0")
    .update(semanticInput)
    .digest("hex");
  return {
    id: `dvd-structural-assessment:${digest}`,
    policyVersion: DVD_STRUCTURAL_ASSESSMENT_POLICY_VERSION,
    checkpoint,
    validity,
    findings,
  };
}
