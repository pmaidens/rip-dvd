import { expect, it } from "vitest";
import type {
  ConsistentReadAccess,
  DvdCatalogReviewWorkflowEvidence,
  OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import {
  CatalogReviewCompletionUnavailableError,
  describeCatalogReviewWorkflow,
  type CatalogReviewWorkflow,
} from "./catalog-review-workflow.js";

const archiveId = "synthetic-archive" as OriginalDiscArchiveId;

function decisionReadyEvidence(
  acceptanceRequired: boolean,
): DvdCatalogReviewWorkflowEvidence {
  return {
    archiveJobs: [{
      id: "synthetic-archive-job",
      evidenceFormat: "dvd-recovery-evidence-v1",
      status: "completed",
    }],
    evidenceHeader: {
      sourceArchiveJobId: "synthetic-archive-job",
      evidenceFormat: "dvd-recovery-evidence-v1",
      currentManifestRevision: 2,
      currentManifestDigest: "synthetic-digest",
    },
    recovery: {
      id: "synthetic-recovery",
      attemptId: "synthetic-attempt",
      status: "completed",
      work: null,
    },
    titleIdentity: {
      reviewSetIdentity: "synthetic-review-set",
      currentMappingStates: ["mapped"],
    },
    titleDamage: {
      state: "current",
      currentAssessmentIdentity: "synthetic-assessment",
      acceptanceRequired,
    },
  } as unknown as DvdCatalogReviewWorkflowEvidence;
}

it("rejects legacy completion without inventing a damage acceptance requirement", () => {
  const workflow = {
    schemaVersion: 1,
    evidenceFormat: "dvd-recovery-evidence-v1",
    facts: {
      saved: true,
      recovering: false,
      mapped: true,
      mappingState: "mapped",
      readyForDamageDecision: true,
      readyForEncoding: false,
    },
    current: {
      originalDiscArchiveId: "synthetic-archive",
      archiveJob: { id: "synthetic-archive-job", status: "completed" },
      checkpoint: { revision: 2, manifestDigest: "synthetic-digest" },
      recovery: {
        id: "synthetic-recovery",
        attemptId: "synthetic-attempt",
        state: "completed",
        work: null,
      },
      titleIdentityReviewSetId: "synthetic-review-set",
      titleDamageAssessmentId: "synthetic-assessment",
    },
    actions: [{
      action: "catalog_mapping",
      available: true,
      reasons: [],
      expectedInputs: ["catalogRevision", "mutationKey"],
    }, {
      action: "damage_decision",
      available: false,
      reasons: [{
        code: "CATALOG_DAMAGE_DECISION_UNAVAILABLE",
        message: "Synthetic rollout fence",
        details: { evidenceFormat: "dvd-recovery-evidence-v1" },
      }],
      expectedInputs: [
        "checkpointRevision",
        "assessmentIdentity",
        "reviewSetIdentity",
        "mutationKey",
      ],
    }, {
      action: "encode",
      available: false,
      reasons: [],
      expectedInputs: [
        "checkpointRevision",
        "assessmentIdentity",
        "reviewSetIdentity",
        "acceptanceIdentity",
      ],
    }],
  } satisfies CatalogReviewWorkflow;

  expect(new CatalogReviewCompletionUnavailableError(workflow)).toMatchObject({
    code: "CATALOG_REVIEW_COMPLETION_UNAVAILABLE",
    blockingReasons: [{
      code: "CATALOG_REVIEW_COMPLETION_UNAVAILABLE",
      details: {
        evidenceFormat: "dvd-recovery-evidence-v1",
        replacementAction: "damage_decision",
      },
    }],
    current: workflow.current,
  });
});

it("requires acceptance only when the current damage assessment proves it is needed", () => {
  const access = {} as ConsistentReadAccess;
  const cleanWorkflow = describeCatalogReviewWorkflow(
    access,
    archiveId,
    decisionReadyEvidence(false),
  );
  const damagedWorkflow = describeCatalogReviewWorkflow(
    access,
    archiveId,
    decisionReadyEvidence(true),
  );

  expect(cleanWorkflow?.facts.readyForDamageDecision).toBe(true);
  expect(cleanWorkflow?.actions.find(({ action }) =>
    action === "damage_decision"
  )).toMatchObject({
    available: false,
    reasons: [{ code: "CATALOG_DAMAGE_DECISION_UNAVAILABLE" }],
  });

  expect(cleanWorkflow?.actions.find(({ action }) => action === "encode")
    ?.reasons.map(({ code }) => code)).toEqual([
      "DVD_RECOVERY_EVIDENCE_ENCODING_UNAVAILABLE",
    ]);
  expect(damagedWorkflow?.actions.find(({ action }) => action === "encode")
    ?.reasons.map(({ code }) => code)).toEqual([
      "ACCEPTANCE_REQUIRED",
      "DVD_RECOVERY_EVIDENCE_ENCODING_UNAVAILABLE",
    ]);
});

it("blocks a damage decision while an absent retained title needs mapping review", () => {
  const evidence = decisionReadyEvidence(false);
  const workflow = describeCatalogReviewWorkflow(
    {} as ConsistentReadAccess,
    archiveId,
    {
      ...evidence,
      titleIdentity: {
        reviewSetIdentity: "synthetic-review-set",
        currentMappingStates: ["mapped", "needs_mapping_review"],
      },
    },
  );

  expect(workflow?.facts).toMatchObject({
    mapped: false,
    mappingState: "needs_mapping_review",
    readyForDamageDecision: false,
  });
  expect(workflow?.actions.find(({ action }) => action === "damage_decision"))
    .toMatchObject({
      available: false,
      reasons: [{
        code: "MAPPING_REVIEW_REQUIRED",
        details: { affectedTitleCount: 1 },
      }, { code: "CATALOG_DAMAGE_DECISION_UNAVAILABLE" }],
    });
});

it("keeps a no-progress Recovery pause active and decision-blocking", () => {
  const evidence = decisionReadyEvidence(false);
  const workflow = describeCatalogReviewWorkflow(
    {} as ConsistentReadAccess,
    archiveId,
    {
      ...evidence,
      recovery: { ...evidence.recovery!, status: "paused" },
    },
  );

  expect(workflow?.facts).toMatchObject({
    recovering: true,
    readyForDamageDecision: false,
  });
  expect(workflow?.actions.find(({ action }) =>
    action === "damage_decision"
  )?.reasons.map(({ code }) => code)).toEqual([
    "RECOVERY_ACTIVE",
    "CATALOG_DAMAGE_DECISION_UNAVAILABLE",
  ]);
});

it("does not advertise mapping before current Title Identity evidence exists", () => {
  const evidence = decisionReadyEvidence(false);
  const workflow = describeCatalogReviewWorkflow(
    {} as ConsistentReadAccess,
    archiveId,
    { ...evidence, titleIdentity: null },
  );

  expect(workflow?.facts.mappingState).toBe("pending");
  expect(workflow?.actions.find(({ action }) =>
    action === "catalog_mapping"
  )).toMatchObject({
    available: false,
    reasons: [{ code: "SELECTION_UNIDENTIFIED" }],
  });
});
