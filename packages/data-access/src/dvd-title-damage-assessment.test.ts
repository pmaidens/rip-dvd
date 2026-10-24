import { describe, expect, it } from "vitest";

import {
  createDvdTitleDamageAssessment,
  dvdTitleDamageAssessmentRequiresAcceptance,
  type DvdTitleDamageAssessmentInput,
} from "./dvd-title-damage-assessment.js";
import type {
  ArchiveRecoveryAttemptId,
  ArchiveRecoveryId,
  DvdDiscConfirmationId,
  DvdDiscVerificationId,
  DvdTitleIdentityId,
  DvdTitleIdentityObservationId,
  OriginalDiscArchiveId,
} from "./types.js";

const archiveId = "synthetic-archive" as OriginalDiscArchiveId;
const titleId = (suffix: number) =>
  `synthetic-title-${suffix}` as DvdTitleIdentityId;
const observationId = (suffix: number) =>
  `synthetic-observation-${suffix}` as DvdTitleIdentityObservationId;

const checkpoint = {
  originalDiscArchiveId: archiveId,
  manifestId: "synthetic-manifest-1",
  manifestRevision: 1,
  manifestDigest: "a".repeat(64),
  acceptedEndLbaExclusive: 1_000,
};

function assessmentInput(): DvdTitleDamageAssessmentInput {
  return {
    checkpoint,
    titleIdentityReviewSetIdentity: "b".repeat(64),
    catalogMappingProjectionId: "d".repeat(64),
    structuralAssessmentIdentity: `dvd-structural-assessment:${"c".repeat(64)}`,
    structuralFindings: {
      dvdNavigation: "valid",
      titleEnumeration: "valid",
    },
    unrecoveredSourceRanges: [
      {
        startLba: 15,
        sectorCount: 5,
        classification: "individually_failed",
      },
      {
        startLba: 205,
        sectorCount: 2,
        classification: "skipped_untested",
      },
    ],
    sourceContinuity: {
      policyVersion: "dvd-title-source-continuity-v1",
      provenance: [{
        discConfirmationId:
          "synthetic-confirmation-1" as DvdDiscConfirmationId,
        archiveRecoveryId: "synthetic-recovery-1" as ArchiveRecoveryId,
        archiveRecoveryAttemptId:
          "synthetic-recovery-attempt-1" as ArchiveRecoveryAttemptId,
        verificationId:
          "synthetic-verification-1" as DvdDiscVerificationId,
        verificationOutcome: "mismatch",
        verificationResultDigest: "e".repeat(64),
        confirmationCheckpoint: {
          manifestRevision: 1,
          manifestDigest: "f".repeat(64),
        },
        recoveredSourceRanges: [
          { startLba: 25, sectorCount: 3 },
          { startLba: 400, sectorCount: 2 },
        ],
      }],
    },
    titles: [
      {
        titleIdentityId: titleId(1),
        titleIdentityObservationId: observationId(1),
        displayTitleNumber: 1,
        selection: {
          selectedPath: [{
            programNumber: 1,
            cellNumber: 1,
            vobId: 1,
            cellId: 1,
          }],
          angleNumber: 1,
          chapterStart: 1,
          chapterEnd: 4,
        },
        sourceReferences: [
          { kind: "navigation", startLba: 0, sectorCount: 10 },
          { kind: "multiplexed_content", startLba: 10, sectorCount: 100 },
          { kind: "multiplexed_content", startLba: 10, sectorCount: 100 },
        ],
        mappingCoverage: {
          state: "complete",
          policyVersion: "synthetic-title-map-v1",
          unknownReasons: [],
        },
      },
      {
        titleIdentityId: titleId(2),
        titleIdentityObservationId: observationId(2),
        displayTitleNumber: 2,
        selection: {
          selectedPath: [{
            programNumber: 1,
            cellNumber: 1,
            vobId: 2,
            cellId: 1,
          }],
          angleNumber: 1,
          chapterStart: 1,
          chapterEnd: 1,
        },
        sourceReferences: [
          { kind: "navigation", startLba: 0, sectorCount: 10 },
          { kind: "multiplexed_content", startLba: 10, sectorCount: 50 },
        ],
        mappingCoverage: {
          state: "complete",
          policyVersion: "synthetic-title-map-v1",
          unknownReasons: [],
        },
      },
      {
        titleIdentityId: titleId(3),
        titleIdentityObservationId: observationId(3),
        displayTitleNumber: 3,
        selection: {
          selectedPath: [{
            programNumber: 1,
            cellNumber: 1,
            vobId: 3,
            cellId: 1,
          }],
          angleNumber: 2,
          chapterStart: 2,
          chapterEnd: 3,
        },
        sourceReferences: [
          { kind: "multiplexed_content", startLba: 200, sectorCount: 2 },
        ],
        mappingCoverage: {
          state: "partial",
          policyVersion: "synthetic-title-map-v1",
          unknownReasons: [{
            code: "TITLE_SOURCE_MAP_INCOMPLETE",
            message: "The selected path has unresolved navigation.",
          }],
        },
      },
    ],
  };
}

describe("createDvdTitleDamageAssessment", () => {
  it("deduplicates a title's physical references and counts shared sectors for each title", () => {
    const assessment = createDvdTitleDamageAssessment(assessmentInput());

    expect(assessment.items[0]).toMatchObject({
      titleIdentityId: "synthetic-title-1",
      uniqueSourceSectorCount: 110,
      unrecoveredUniqueSourceSectorCount: 5,
      titleMissingSourcePercentage: 5 / 110 * 100,
      knownUnrecoveredSourceRanges: [{
        startLba: 15,
        sectorCount: 5,
        classification: "individually_failed",
      }],
      knownSourceContinuityRiskRanges: [{
        startLba: 25,
        sectorCount: 3,
        discConfirmationId: "synthetic-confirmation-1",
        verificationOutcome: "mismatch",
      }],
      sourceContinuityRiskSectorCount: 3,
    });
    expect(assessment.items[1]).toMatchObject({
      uniqueSourceSectorCount: 60,
      unrecoveredUniqueSourceSectorCount: 5,
      titleMissingSourcePercentage: 5 / 60 * 100,
      sourceContinuityRiskSectorCount: 3,
    });
    expect(assessment.items[2]).toMatchObject({
      uniqueSourceSectorCount: null,
      unrecoveredUniqueSourceSectorCount: 0,
      titleMissingSourcePercentage: null,
      mappingCoverage: { state: "partial" },
    });
    expect(assessment.unknownTitleImpact).toEqual({
      unrecoveredSourceSectorCount: 2,
      unrecoveredSourceRanges: [{
        startLba: 205,
        sectorCount: 2,
        classification: "skipped_untested",
      }],
      reasons: [{
        code: "TITLE_SOURCE_MAP_INCOMPLETE",
        message: "At least one selected title path has incomplete source coverage.",
      }],
    });
    expect(assessment.noTitleMissingSourceProved).toBe(false);
    expect(assessment.sourceContinuity).toMatchObject({
      policyVersion: "dvd-title-source-continuity-v1",
      sourceContinuityRiskSectorCount: 5,
    });
    expect(assessment.unattributedSourceContinuityRisk).toEqual({
      sourceSectorCount: 2,
      sourceRanges: [{
        startLba: 400,
        sectorCount: 2,
        discConfirmationId: "synthetic-confirmation-1",
        verificationOutcome: "mismatch",
      }],
    });
    expect(dvdTitleDamageAssessmentRequiresAcceptance(assessment)).toBe(true);
  });

  it("omits percentages and refuses a false clean result when navigation is not proved", () => {
    const input = assessmentInput();
    input.structuralFindings.dvdNavigation = "indeterminate";
    input.titles = input.titles.map((title) => ({
      ...title,
      mappingCoverage: {
        state: "partial" as const,
        policyVersion: title.mappingCoverage.policyVersion,
        unknownReasons: [{
          code: "DVD_NAVIGATION_NOT_PROVED",
          message: "DVD navigation is indeterminate at this checkpoint.",
        }],
      },
    }));

    const assessment = createDvdTitleDamageAssessment(input);

    expect(assessment.items.every((item) =>
      item.titleMissingSourcePercentage === null &&
      item.uniqueSourceSectorCount === null
    )).toBe(true);
    expect(assessment.noTitleMissingSourceProved).toBe(false);
    expect(assessment.unknownTitleImpact.reasons).toContainEqual({
      code: "DVD_NAVIGATION_NOT_PROVED",
      message: "DVD navigation is not proved for this checkpoint.",
    });
  });

  it("rejects complete coverage when structural evidence cannot support it", () => {
    const input = assessmentInput();
    input.structuralFindings.titleEnumeration = "invalid";

    expect(() => createDvdTitleDamageAssessment(input)).toThrow(
      /complete title source coverage requires valid navigation and title enumeration/i,
    );
  });

  it("keeps a stable identity for semantically identical evidence", () => {
    const first = createDvdTitleDamageAssessment(assessmentInput());
    const second = createDvdTitleDamageAssessment(assessmentInput());

    expect(second.id).toBe(first.id);
  });

  it("changes identity when confirmed-source continuity changes", () => {
    const firstInput = assessmentInput();
    const first = createDvdTitleDamageAssessment(firstInput);
    const secondInput = assessmentInput();
    secondInput.sourceContinuity = {
      ...secondInput.sourceContinuity!,
      provenance: [{
        ...secondInput.sourceContinuity!.provenance[0]!,
        recoveredSourceRanges: [{ startLba: 26, sectorCount: 2 }],
      }],
    };
    const second = createDvdTitleDamageAssessment(secondInput);

    expect(second.id).not.toBe(first.id);
  });

  it("requires a decision for continuity risk after all source recovers", () => {
    const input = assessmentInput();
    input.unrecoveredSourceRanges = [];
    input.titles = input.titles.slice(0, 2);

    const assessment = createDvdTitleDamageAssessment(input);

    expect(assessment.noTitleMissingSourceProved).toBe(true);
    expect(assessment.sourceContinuity?.sourceContinuityRiskSectorCount).toBe(5);
    expect(dvdTitleDamageAssessmentRequiresAcceptance(assessment)).toBe(true);
  });

  it("preserves the identity of evidence written before continuity tracking", () => {
    const input = assessmentInput();
    input.sourceContinuity = null;

    expect(createDvdTitleDamageAssessment(input).id).toBe(
      "dvd-title-damage-assessment:fab9e13eea28b55b987e759b64c23368a7b88e1d39f069c2ab798f364d1648a8",
    );
  });

  it("binds current identities to the Catalog mapping projection", () => {
    const firstInput = assessmentInput();
    const first = createDvdTitleDamageAssessment(firstInput);
    const remapped = createDvdTitleDamageAssessment({
      ...firstInput,
      catalogMappingProjectionId: "e".repeat(64),
    });
    const migrated = createDvdTitleDamageAssessment({
      ...firstInput,
      catalogMappingProjectionId: null,
    });

    expect(remapped.id).not.toBe(first.id);
    expect(migrated.id).not.toBe(first.id);
  });

  it("uses locale-independent ordering for identity-bearing text", () => {
    const firstInput = assessmentInput();
    firstInput.titles = firstInput.titles.slice(0, 2).map((title, index) => ({
      ...title,
      titleIdentityObservationId: (
        index === 0 ? "synthetic-observation-ä" : "synthetic-observation-z"
      ) as DvdTitleIdentityObservationId,
      displayTitleNumber: 1,
      mappingCoverage: {
        state: "partial" as const,
        policyVersion: title.mappingCoverage.policyVersion,
        unknownReasons: [
          { code: "SYNTHETIC_REASON", message: "ä reason" },
          { code: "SYNTHETIC_REASON", message: "z reason" },
        ],
      },
    }));
    const secondInput = structuredClone(firstInput);
    secondInput.titles.reverse();
    for (const title of secondInput.titles) {
      title.mappingCoverage.unknownReasons = [
        ...title.mappingCoverage.unknownReasons,
      ].reverse();
    }

    const first = createDvdTitleDamageAssessment(firstInput);
    const second = createDvdTitleDamageAssessment(secondInput);

    expect(first.items.map((item) => item.titleIdentityObservationId)).toEqual([
      "synthetic-observation-z",
      "synthetic-observation-ä",
    ]);
    expect(first.items[0]?.mappingCoverage.unknownReasons).toEqual([
      { code: "SYNTHETIC_REASON", message: "z reason" },
      { code: "SYNTHETIC_REASON", message: "ä reason" },
    ]);
    expect(second.id).toBe(first.id);
  });
});
