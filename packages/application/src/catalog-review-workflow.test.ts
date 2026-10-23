import { expect, it } from "vitest";

import {
  CatalogReviewCompletionUnavailableError,
  type CatalogReviewWorkflow,
} from "./catalog-review-workflow.js";

it("rejects legacy completion with an actionable reason when a damage decision is ready", () => {
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
      available: true,
      reasons: [],
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
      code: "ACCEPTANCE_REQUIRED",
      details: { originalDiscArchiveId: "synthetic-archive" },
    }],
    current: workflow.current,
  });
});
