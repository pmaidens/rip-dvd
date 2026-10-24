import { expect, it } from "vitest";
import type {
  ConsistentReadAccess,
  DataAccess,
  DvdCatalogReviewWorkflowEvidence,
  OriginalDiscArchiveId,
} from "@rip-dvd/data-access";
import {
  CatalogMappingEvidenceUnavailableError,
  StaleCatalogRevisionError,
} from "@rip-dvd/data-access";

import {
  CatalogReviewCompletionUnavailableError,
  CatalogReviewMappingUnavailableError,
  CatalogReviewRevisionStaleError,
  describeCatalogReviewWorkflow,
  rethrowCatalogMappingOperationError,
  type CatalogReviewWorkflow,
} from "./catalog-review-workflow.js";

const archiveId = "synthetic-archive" as OriginalDiscArchiveId;

function decisionReadyEvidence(
  acceptanceRequired: boolean,
): DvdCatalogReviewWorkflowEvidence {
  return {
    catalogReview: {
      catalogRevision: "2026-10-24T00:00:00.000Z",
      outcome: "needs_review",
    },
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
      catalogMappingProjectionId: "synthetic-mapping-projection",
      currentMappingStates: ["mapped"],
      currentDefaultAngleTitleCount: 1,
    },
    titleDamage: {
      state: "current",
      currentAssessmentIdentity: "synthetic-assessment",
      acceptanceRequired,
    },
    choiceHistory: [],
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
      archiveOnly: false,
    },
    current: {
      originalDiscArchiveId: "synthetic-archive",
      catalogRevision: "2026-10-24T00:00:00.000Z",
      catalogReviewOutcome: "needs_review",
      archiveJob: { id: "synthetic-archive-job", status: "completed" },
      checkpoint: { revision: 2, manifestDigest: "synthetic-digest" },
      recovery: {
        id: "synthetic-recovery",
        attemptId: "synthetic-attempt",
        state: "completed",
        work: null,
      },
      catalogMappingProjectionId: "synthetic-mapping-projection",
      titleDamageAssessmentId: "synthetic-assessment",
    },
    choiceHistory: [],
    choiceHistoryPage: { limit: 100, truncated: false },
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

it("offers archive-only only for stopped or completed Recovery", () => {
  const completed = describeCatalogReviewWorkflow(
    {} as ConsistentReadAccess,
    archiveId,
    decisionReadyEvidence(false),
  );
  const activeEvidence = decisionReadyEvidence(false);
  const active = describeCatalogReviewWorkflow(
    {} as ConsistentReadAccess,
    archiveId,
    {
      ...activeEvidence,
      recovery: { ...activeEvidence.recovery!, status: "running" },
    },
  );

  expect(completed?.actions.find(({ action }) => action === "archive_only"))
    .toMatchObject({ available: true, reasons: [] });
  expect(completed?.actions.find(({ action }) => action === "reopen"))
    .toMatchObject({
      available: false,
      reasons: [{ code: "CATALOG_REVIEW_OPEN" }],
    });
  expect(active?.actions.find(({ action }) => action === "archive_only"))
    .toMatchObject({
      available: false,
      reasons: [{ code: "RECOVERY_ACTIVE" }],
    });
});

it("keeps archive-only through later Recovery while allowing explicit reopen", () => {
  const evidence = decisionReadyEvidence(false);
  const workflow = describeCatalogReviewWorkflow(
    {} as ConsistentReadAccess,
    archiveId,
    {
      ...evidence,
      catalogReview: {
        ...evidence.catalogReview!,
        outcome: "archive_only",
      },
      recovery: { ...evidence.recovery!, status: "running" },
    },
  );

  expect(workflow?.facts.archiveOnly).toBe(true);
  expect(workflow?.actions.find(({ action }) => action === "catalog_mapping")
    ?.reasons.map(({ code }) => code)).toContain(
      "CATALOG_REVIEW_ARCHIVE_ONLY",
    );
  expect(workflow?.actions.find(({ action }) => action === "reopen"))
    .toMatchObject({ available: true, reasons: [] });
  expect(workflow?.actions.find(({ action }) => action === "encode")
    ?.reasons.map(({ code }) => code)).toContain(
      "CATALOG_REVIEW_ARCHIVE_ONLY",
    );
});

it("blocks a damage decision while an absent retained title needs mapping review", () => {
  const evidence = decisionReadyEvidence(false);
  const workflow = describeCatalogReviewWorkflow(
    {} as ConsistentReadAccess,
    archiveId,
    {
      ...evidence,
      titleIdentity: {
        catalogMappingProjectionId: "synthetic-mapping-projection",
        currentMappingStates: ["mapped", "needs_mapping_review"],
        currentDefaultAngleTitleCount: 1,
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

it("blocks mapping when Archive Recovery has faulted", () => {
  const evidence = decisionReadyEvidence(false);
  const workflow = describeCatalogReviewWorkflow(
    {} as ConsistentReadAccess,
    archiveId,
    {
      ...evidence,
      recovery: { ...evidence.recovery!, status: "faulted" },
    },
  );

  expect(workflow?.actions.find(({ action }) =>
    action === "catalog_mapping"
  )).toMatchObject({
    available: false,
    reasons: [{ code: "CONSISTENCY_FAULT" }],
  });
  expect(workflow?.facts.readyForDamageDecision).toBe(false);
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
  });
  expect(workflow?.actions.find(({ action }) =>
    action === "catalog_mapping"
  )?.reasons).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "SELECTION_UNIDENTIFIED" }),
  ]));
});

it("does not advertise mapping when only retained absent-title evidence exists", () => {
  const evidence = decisionReadyEvidence(false);
  const workflow = describeCatalogReviewWorkflow(
    {} as ConsistentReadAccess,
    archiveId,
    {
      ...evidence,
      titleIdentity: {
        catalogMappingProjectionId: "synthetic-retained-mapping-projection",
        currentMappingStates: ["needs_mapping_review"],
        currentDefaultAngleTitleCount: 0,
      },
    },
  );

  expect(workflow?.facts.mappingState).toBe("pending");
  expect(workflow?.actions.find(({ action }) =>
    action === "catalog_mapping"
  )).toMatchObject({
    available: false,
  });
  expect(workflow?.actions.find(({ action }) =>
    action === "catalog_mapping"
  )?.reasons).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "SELECTION_UNIDENTIFIED" }),
  ]));
});

it("preserves a transactional mapping rejection if the latest workflow recovered", () => {
  const workflow = describeCatalogReviewWorkflow(
    {} as ConsistentReadAccess,
    archiveId,
    decisionReadyEvidence(false),
  )!;
  const access = {
    readConsistentSnapshot: () => ({
      workflow,
      archive: { updatedAt: new Date("2026-10-23T12:00:00.000Z") },
    }),
  } as unknown as Pick<DataAccess, "readConsistentSnapshot">;

  expect(() => rethrowCatalogMappingOperationError(
    access,
    archiveId,
    new Date("2026-10-23T11:00:00.000Z"),
    new CatalogMappingEvidenceUnavailableError(),
  )).toThrowError(CatalogReviewMappingUnavailableError);
  try {
    rethrowCatalogMappingOperationError(
      access,
      archiveId,
      new Date("2026-10-23T11:00:00.000Z"),
      new CatalogMappingEvidenceUnavailableError(),
    );
  } catch (error) {
    expect(error).toMatchObject({
      code: "CATALOG_MAPPING_UNAVAILABLE",
      blockingReasons: [{
        code: "CONSISTENCY_FAULT",
        details: { rejectedBy: "transactional_catalog_mapping_guard" },
      }],
      current: workflow.current,
    });
  }
});

it("preserves stale legacy mapping failures at the shared boundary", () => {
  const access = {
    readConsistentSnapshot: () => ({
      workflow: null,
      archive: { updatedAt: new Date("2026-10-23T12:00:00.000Z") },
    }),
  } as unknown as Pick<DataAccess, "readConsistentSnapshot">;
  const stale = new StaleCatalogRevisionError(
    "Catalog review revision is stale",
  );

  expect(() => rethrowCatalogMappingOperationError(
    access,
    archiveId,
    new Date("2026-10-23T11:00:00.000Z"),
    stale,
  )).toThrowError(StaleCatalogRevisionError);
  try {
    rethrowCatalogMappingOperationError(
      access,
      archiveId,
      new Date("2026-10-23T11:00:00.000Z"),
      stale,
    );
  } catch (error) {
    expect(error).toBe(stale);
  }
});
