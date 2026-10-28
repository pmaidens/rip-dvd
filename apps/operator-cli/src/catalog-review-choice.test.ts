import { afterEach, expect, it } from "vitest";

import {
  CatalogReviewChoiceStaleError,
  CatalogReviewChoiceUnavailableError,
  createApplicationOperations,
} from "@rip-dvd/application";
import {
  MutationKeyConflictError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import {
  advanceCommittedArchiveEvidence,
  seedCommittedArchiveEvidence,
  withEvidenceGuardsDisabled,
} from "./archive-evidence.test-support.js";
import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

const fixtures: ReturnType<typeof createOperatorWorkflowFixture>[] = [];
const key = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

interface ChoiceReview {
  catalogRevision: string;
  reviewOutcome: "needs_review" | "reviewed_with_selections" | "archive_only";
  reviewWorkflow: {
    facts: { archiveOnly: boolean };
    current: {
      checkpoint: { revision: number; manifestDigest: string };
    };
    choiceHistory: Array<{
      id: string;
      choice: "archive_only" | "reopen";
      checkpoint: { revision: number; manifestDigest: string };
      recovery: { state: string };
    }>;
    actions: Array<{
      action: string;
      available: boolean;
      reasons: Array<{ code: string }>;
    }>;
  };
}

function show(
  access: DataAccess,
  archiveId: string,
): ChoiceReview {
  const review = createApplicationOperations(access).catalogReview(
    archiveId as OriginalDiscArchiveId,
    {
      discSelectionOffset: 0,
      correctionHistoryOffset: 0,
      correctionEncodeHistoryOffset: 0,
      correctionRetainedOutputHistoryOffset: 0,
      replacementOffset: 0,
      replacementProfileOffset: 0,
    },
    false,
  );
  if (review?.reviewWorkflow === undefined) {
    throw new Error("Expected a DVD Recovery Catalog Review workflow");
  }
  return review as unknown as ChoiceReview;
}

function choiceArgs(
  verb: "archive-only" | "reopen",
  archiveId: string,
  mutationKey: string,
  review: ChoiceReview,
) {
  return [
    "catalog-review",
    verb,
    archiveId,
    "--key",
    mutationKey,
    "--revision",
    review.catalogRevision,
    "--checkpoint-revision",
    String(review.reviewWorkflow.current.checkpoint.revision),
    "--checkpoint-digest",
    review.reviewWorkflow.current.checkpoint.manifestDigest,
  ];
}

function setReviewOpenAndRecoveryState(
  databasePath: string,
  archiveId: string,
  recoveryState: "eligible" | "running" | "completed",
): void {
  withEvidenceGuardsDisabled(databasePath, (sqlite) => {
    sqlite.prepare(`
      UPDATE original_disc_archives
      SET catalog_review_outcome = 'needs_review',
          catalog_reviewed_at = NULL,
          updated_at = updated_at + 1
      WHERE id = ?
    `).run(archiveId);
    sqlite.prepare(`
      UPDATE archive_recoveries
      SET status = ?, updated_at = updated_at + 1
      WHERE original_disc_archive_id = ?
    `).run(recoveryState, archiveId);
  });
}

function setRecoveryState(
  databasePath: string,
  archiveId: string,
  recoveryState: "running" | "completed",
): void {
  withEvidenceGuardsDisabled(databasePath, (sqlite) => {
    sqlite.prepare(`
      UPDATE archive_recoveries
      SET status = ?, updated_at = updated_at + 1
      WHERE original_disc_archive_id = ?
    `).run(recoveryState, archiveId);
  });
}

it("records archive-only and reopen choices against durable current evidence", async () => {
  const fixture = createOperatorWorkflowFixture();
  fixtures.push(fixture);
  const { archive, manifest } = await seedCommittedArchiveEvidence(fixture, [{
    startLba: 24,
    sectorCount: 2,
    classification: "skipped_untested",
  }], false, true);
  setReviewOpenAndRecoveryState(fixture.databasePath, archive.id, "eligible");
  const access = fixture.openAccess();
  const operations = createApplicationOperations(access);

  const active = show(access, archive.id);
  expect(() => operations.recordCatalogReviewEvidenceChoice(
    archive.id,
    {
      action: "archive_only",
      catalogRevision: active.catalogRevision,
      checkpointRevision: active.reviewWorkflow.current.checkpoint.revision,
      checkpointDigest:
        active.reviewWorkflow.current.checkpoint.manifestDigest,
    },
    key(1),
  )).toThrowError(CatalogReviewChoiceUnavailableError);
  try {
    operations.recordCatalogReviewEvidenceChoice(
      archive.id,
      {
        action: "archive_only",
        catalogRevision: active.catalogRevision,
        checkpointRevision: active.reviewWorkflow.current.checkpoint.revision,
        checkpointDigest:
          active.reviewWorkflow.current.checkpoint.manifestDigest,
      },
      key(1),
    );
  } catch (error) {
    expect(error).toMatchObject({
      code: "CATALOG_REVIEW_CHOICE_UNAVAILABLE",
      blockingReasons: [{ code: "RECOVERY_ACTIVE" }],
    });
  }

  setRecoveryState(fixture.databasePath, archive.id, "completed");
  const stable = show(access, archive.id);
  const archiveOnlyArgs = choiceArgs(
    "archive-only",
    archive.id,
    key(2),
    stable,
  );
  const recorded = await fixture.run(archiveOnlyArgs);
  expect(recorded.exitCode).toBe(0);
  expect(recorded.result).toMatchObject({
    message: "Catalog Review set to archive-only",
    choice: {
      action: "archive_only",
      checkpoint: { revision: 1 },
      recovery: { state: "completed" },
    },
    archive: { catalogReviewOutcome: "archive_only" },
  });
  expect(operations.recordCatalogReviewEvidenceChoice(
    archive.id,
    {
      action: "archive_only",
      catalogRevision: stable.catalogRevision,
      checkpointRevision: stable.reviewWorkflow.current.checkpoint.revision,
      checkpointDigest:
        stable.reviewWorkflow.current.checkpoint.manifestDigest,
    },
    key(2),
  )).toEqual(recorded.result);

  expect(() => operations.recordCatalogReviewEvidenceChoice(
    archive.id,
    {
      action: "archive_only",
      catalogRevision: stable.catalogRevision,
      checkpointRevision: stable.reviewWorkflow.current.checkpoint.revision,
      checkpointDigest: "f".repeat(64),
    },
    key(2),
  )).toThrowError(MutationKeyConflictError);

  setRecoveryState(fixture.databasePath, archive.id, "running");
  const duringLaterRecovery = show(access, archive.id);
  expect(duringLaterRecovery).toMatchObject({
    reviewOutcome: "archive_only",
    reviewWorkflow: {
      facts: { archiveOnly: true },
      choiceHistory: [{ choice: "archive_only" }],
    },
  });
  const mappingAction = duringLaterRecovery.reviewWorkflow.actions.find(
    ({ action }) => action === "catalog_mapping",
  );
  expect(mappingAction?.available).toBe(false);
  expect(mappingAction?.reasons.map(({ code }) => code)).toContain(
    "CATALOG_REVIEW_ARCHIVE_ONLY",
  );

  advanceCommittedArchiveEvidence(fixture, manifest, {
    createdAtMs: new Date(duringLaterRecovery.catalogRevision).getTime() + 1,
  });
  expect(() => operations.recordCatalogReviewEvidenceChoice(
    archive.id,
    {
      action: "reopen",
      catalogRevision: duringLaterRecovery.catalogRevision,
      checkpointRevision:
        duringLaterRecovery.reviewWorkflow.current.checkpoint.revision,
      checkpointDigest:
        duringLaterRecovery.reviewWorkflow.current.checkpoint.manifestDigest,
    },
    key(3),
  )).toThrowError(CatalogReviewChoiceStaleError);

  const current = show(access, archive.id);
  const encodeJobCount = access.encodeJobs.list().length;
  const reopened = await fixture.run(
    choiceArgs("reopen", archive.id, key(4), current),
  );
  expect(reopened.exitCode).toBe(0);
  expect(reopened.result).toMatchObject({
    message: "Catalog Review reopened",
    choice: { action: "reopen", checkpoint: { revision: 2 } },
    archive: {
      catalogReviewedAt: null,
      catalogReviewOutcome: "needs_review",
    },
  });

  const finalReview = show(access, archive.id);
  expect(finalReview.reviewWorkflow.choiceHistory.map(({ choice }) => choice))
    .toEqual(["reopen", "archive_only"]);
  expect(finalReview.reviewWorkflow.choiceHistory.map(({ checkpoint }) =>
    checkpoint.revision
  )).toEqual([2, 1]);
  expect(access.encodeJobs.list()).toHaveLength(encodeJobCount);
  expect(access.catalog.listCatalogReviewEvidenceChoices(
    archive.id,
    { limit: 100 },
  ))
    .toHaveLength(2);
  access.close();
});
