import { describe, expect, it } from "vitest";

import {
  createDvdStructuralAssessment,
  type DvdStructuralFindingInput,
} from "./dvd-structural-assessment.js";

const checkpoint = {
  originalDiscArchiveId: "synthetic-archive",
  manifestId: "synthetic-manifest",
  manifestRevision: 2,
  manifestDigest: "a".repeat(64),
  acceptedEndLbaExclusive: 400,
} as const;

function finding(
  checkKind: DvdStructuralFindingInput["checkKind"],
  outcome: DvdStructuralFindingInput["outcome"],
): DvdStructuralFindingInput {
  return {
    checkKind,
    policyVersion: "synthetic-check-v1",
    testedExtent: outcome === "not_run"
      ? null
      : { startLba: 0, endLbaExclusive: 400 },
    outcome,
    reason: outcome === "valid"
      ? null
      : { code: "SYNTHETIC_RESULT", message: "Synthetic structural result." },
    evidenceReference: `synthetic-evidence:${checkKind}:${outcome}`,
  };
}

describe("DVD structural assessment", () => {
  it("is valid only when every required structural check passes", () => {
    const valid = createDvdStructuralAssessment({
      checkpoint,
      findings: [
        finding("filesystem_structure", "valid"),
        finding("dvd_navigation", "valid"),
        finding("title_enumeration", "valid"),
      ],
    });
    const unknown = createDvdStructuralAssessment({
      checkpoint,
      findings: [
        finding("filesystem_structure", "valid"),
        finding("dvd_navigation", "indeterminate"),
        finding("title_enumeration", "not_run"),
      ],
    });
    const invalid = createDvdStructuralAssessment({
      checkpoint,
      findings: [
        finding("filesystem_structure", "invalid"),
        finding("dvd_navigation", "not_run"),
        finding("title_enumeration", "not_run"),
      ],
    });

    expect(valid.validity).toBe("valid");
    expect(unknown.validity).toBe("unknown");
    expect(invalid.validity).toBe("invalid");
  });

  it("keeps identity for equivalent evidence and changes it for a contradiction", () => {
    const findings = [
      finding("filesystem_structure", "valid"),
      finding("dvd_navigation", "valid"),
      finding("title_enumeration", "valid"),
    ] as const;
    const original = createDvdStructuralAssessment({ checkpoint, findings });
    const retried = createDvdStructuralAssessment({
      checkpoint,
      findings: [...findings].reverse(),
    });
    const contradicted = createDvdStructuralAssessment({
      checkpoint,
      findings: findings.map((item) => item.checkKind === "dvd_navigation"
        ? {
          ...item,
          outcome: "invalid" as const,
          reason: {
            code: "NAVIGATION_CONTRADICTION",
            message: "Readable navigation claims disagree.",
          },
        }
        : item),
    });

    expect(retried.id).toBe(original.id);
    expect(contradicted.id).not.toBe(original.id);
    expect(contradicted.validity).toBe("invalid");
  });
});
