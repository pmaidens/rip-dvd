import { expect, it } from "vitest";

import { CommandFailure } from
  "../../../../../../operator-cli/src/command.js";
import { runDvdTitleDamageAcceptance } from
  "../../../../../../operator-cli/src/dvd-title-damage-acceptance.js";
import {
  StaleDvdTitleDamageDecisionError,
  type ArchiveRecoveryAttemptId,
  type ArchiveRecoveryId,
  type DataAccess,
  type DvdTitleDamageDecision,
  type RecordDvdTitleDamageDecisionInput,
} from "@rip-dvd/data-access";

import { createDvdTitleDamageAcceptanceRoute } from "./route";

const archiveId = "synthetic-acceptance-archive";
const checkpointDigest = "a".repeat(64);
const reviewSetIdentity = "b".repeat(64);
const catalogMappingProjectionId = "c".repeat(64);
const reviewedContentIdentity = "d".repeat(64);
const assessmentIdentity = `dvd-title-damage-assessment:${"e".repeat(64)}`;
const previewToken =
  "dvd-title-damage-acceptance-preview:00000000-0000-4000-8000-000000000420";
const mutationKey = "00000000-0000-4000-8000-000000000421";

const input = {
  operator: "Synthetic parity operator",
  previewToken,
  checkpointRevision: 4,
  checkpointDigest,
  assessmentIdentity,
  reviewSetIdentity,
  catalogMappingProjectionId,
  reviewedContentIdentity,
  excludedTitleIdentityIds: [],
  mainFeatureResolutions: [],
  damageAcknowledgement: false,
};

function decision(
  accepted: RecordDvdTitleDamageDecisionInput,
): DvdTitleDamageDecision {
  const recordedAt = new Date("2026-10-28T08:00:00.000Z");
  return {
    id: "synthetic-title-damage-decision" as DvdTitleDamageDecision["id"],
    originalDiscArchiveId: accepted.originalDiscArchiveId,
    decision: "not_required",
    operator: accepted.operator,
    catalogRevision: recordedAt,
    checkpointRevision: accepted.checkpoint.revision,
    checkpointDigest: accepted.checkpoint.digest,
    assessmentIdentity: accepted.assessmentIdentity,
    assessmentAttemptSequence: 7,
    reviewSetIdentity: accepted.reviewSetIdentity,
    catalogMappingProjectionId: accepted.catalogMappingProjectionId,
    reviewedContentIdentity: accepted.reviewedContentIdentity,
    excludedTitleIdentityIds: accepted.excludedTitleIdentityIds,
    mainFeatureResolutions: accepted.mainFeatureResolutions,
    snapshot: {
      schemaVersion: 1,
      current: {
        catalogRevision: recordedAt.toISOString(),
        checkpoint: { revision: 4, manifestDigest: checkpointDigest },
        recovery: {
          id: "synthetic-recovery" as ArchiveRecoveryId,
          attemptId: "synthetic-attempt" as ArchiveRecoveryAttemptId,
          state: "stopped",
        },
      },
      reviewSetIdentity,
      catalogMappingProjectionId,
      assessmentIdentity,
      reviewedContentIdentity,
      excludedTitleIdentityIds: [],
      mainFeatureResolutions: [],
      reviewedContent: [],
      exclusions: [],
      assessmentSnapshot: {} as DvdTitleDamageDecision["snapshot"]["assessmentSnapshot"],
      acknowledgementRequired: false,
    },
    recordedAt,
  };
}

function access(options: { stale?: boolean } = {}): DataAccess {
  return {
    catalog: {
      recordDvdTitleDamageDecision(
        accepted: RecordDvdTitleDamageDecisionInput,
      ) {
        if (options.stale) {
          throw new StaleDvdTitleDamageDecisionError({
            catalogRevision: "2026-10-28T08:01:00.000Z",
            checkpoint: { revision: 5, digest: "f".repeat(64) },
            recovery: {
              id: "synthetic-recovery" as ArchiveRecoveryId,
              attemptId: "synthetic-attempt-2" as
                ArchiveRecoveryAttemptId,
              state: "running",
            },
            assessmentIdentity: null,
            reviewSetIdentity: null,
            catalogMappingProjectionId: null,
          });
        }
        return decision(accepted);
      },
    },
    close: () => undefined,
  } as unknown as DataAccess;
}

function request(body: unknown) {
  return new Request(
    `https://operator.example/api/catalog-reviews/${archiveId}/title-damage-acceptance`,
    {
      method: "POST",
      headers: {
        Host: "operator.example",
        Origin: "https://operator.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

it("keeps clean exact-set decisions aligned through web and JSON CLI", async () => {
  const web = await createDvdTitleDamageAcceptanceRoute(
    request({ ...input, mutationKey }),
    archiveId,
    () => access(),
    () => "https://operator.example",
  );
  expect(web.status).toBe(200);
  const webResult = await web.json();
  const cliResult = runDvdTitleDamageAcceptance([
    "accept-damage",
    archiveId,
    "--key",
    mutationKey,
    "--json",
    JSON.stringify(input),
  ], {
    openAccess: () => access(),
  });
  expect(cliResult).toEqual(webResult);
  expect(cliResult).toMatchObject({
    decision: { decision: "not_required" },
    encodingQueued: false,
    watchabilityProved: false,
    outputValidationWaived: false,
  });
});

it("returns the same current identities when an exact-set submission is stale", async () => {
  const web = await createDvdTitleDamageAcceptanceRoute(
    request({ ...input, mutationKey }),
    archiveId,
    () => access({ stale: true }),
    () => "https://operator.example",
  );
  expect(web.status).toBe(409);
  const webProblem = await web.json() as {
    error: { code: string; current: unknown };
  };
  let cliProblem: CommandFailure | null = null;
  try {
    runDvdTitleDamageAcceptance([
      "accept-damage",
      archiveId,
      "--key",
      mutationKey,
      "--json",
      JSON.stringify(input),
    ], {
      openAccess: () => access({ stale: true }),
    });
  } catch (error) {
    if (error instanceof CommandFailure) cliProblem = error;
  }
  expect(cliProblem).toMatchObject({
    code: webProblem.error.code,
    details: { current: webProblem.error.current },
  });
});
