import { expect, it } from "vitest";

import { CommandFailure } from
  "../../../../../../operator-cli/src/command.js";
import { runDvdTitleDamageAcceptanceWithdrawal } from
  "../../../../../../operator-cli/src/dvd-title-damage-acceptance-withdrawal.js";
import {
  MutationKeyConflictError,
  StaleDvdTitleDamageAcceptanceWithdrawalError,
  type DataAccess,
  type DvdTitleDamageDecision,
  type DvdTitleDamageDecisionAffectedWork,
  type DvdTitleDamageDecisionId,
  type OriginalDiscArchiveId,
  type RecordDvdTitleDamageAcceptanceWithdrawalInput,
} from "@rip-dvd/data-access";

import { createDvdTitleDamageAcceptanceWithdrawalPreviewRoute } from
  "../title-damage-acceptance-withdrawal-preview/route";
import { createDvdTitleDamageAcceptanceWithdrawalRoute } from "./route";

const archiveId = "synthetic-withdrawal-archive" as OriginalDiscArchiveId;
const acceptedDecisionId =
  "synthetic-accepted-decision" as DvdTitleDamageDecisionId;
const previewToken =
  "dvd-title-damage-acceptance-withdrawal-preview:00000000-0000-4000-8000-000000000421";
const mutationKey = "00000000-0000-4000-8000-000000000422";
const affectedWork = [{
  id: "synthetic-withdrawal-job",
  discSelectionId: "synthetic-withdrawal-selection",
  status: "queued",
}] as unknown as DvdTitleDamageDecisionAffectedWork[];

function acceptedDecision(): DvdTitleDamageDecision {
  const recordedAt = new Date("2026-10-28T08:00:00.000Z");
  return {
    id: acceptedDecisionId,
    originalDiscArchiveId: archiveId,
    decision: "accepted",
    acceptedDecisionId: null,
    operator: "Synthetic acceptance operator",
    catalogRevision: recordedAt,
    checkpointRevision: 4,
    checkpointDigest: "a".repeat(64),
    assessmentIdentity: `dvd-title-damage-assessment:${"b".repeat(64)}`,
    assessmentAttemptSequence: 7,
    reviewSetIdentity: "c".repeat(64),
    catalogMappingProjectionId: "d".repeat(64),
    reviewedContentIdentity: "e".repeat(64),
    excludedTitleIdentityIds: [],
    mainFeatureResolutions: [],
    snapshot: {
      schemaVersion: 1,
      current: {
        catalogRevision: recordedAt.toISOString(),
        checkpoint: { revision: 4, manifestDigest: "a".repeat(64) },
        recovery: {
          id: "synthetic-recovery",
          attemptId: "synthetic-attempt",
          state: "stopped",
        },
      },
      reviewSetIdentity: "c".repeat(64),
      catalogMappingProjectionId: "d".repeat(64),
      assessmentIdentity: `dvd-title-damage-assessment:${"b".repeat(64)}`,
      reviewedContentIdentity: "e".repeat(64),
      excludedTitleIdentityIds: [],
      mainFeatureResolutions: [],
      reviewedContent: [{
        catalogMappings: [{
          discSelectionId: "synthetic-withdrawal-selection",
        }],
      }],
      exclusions: [],
      assessmentSnapshot: {},
      acknowledgementRequired: true,
      affectedWork,
    },
    recordedAt,
  } as unknown as DvdTitleDamageDecision;
}

function access(options: {
  currentState?: "accepted" | "withdrawn";
  failure?: "stale" | "conflict";
} = {}): DataAccess {
  const accepted = acceptedDecision();
  const withdrawn = {
    ...accepted,
    id: "synthetic-withdrawal-decision" as DvdTitleDamageDecisionId,
    decision: "withdrawn" as const,
    acceptedDecisionId,
    operator: "Synthetic withdrawal operator",
  };
  const current = options.currentState === "withdrawn" ? withdrawn : accepted;
  const mutationResults = new Map<string, {
    semanticInput: string;
    decision: DvdTitleDamageDecision;
  }>();
  let fake: DataAccess;
  fake = {
    readConsistentSnapshot: (task: (snapshot: DataAccess) => unknown) =>
      task(fake),
    catalog: {
      listOriginalDiscArchives: () => [{ id: archiveId }],
      findDvdArchiveEvidenceHeader: () => ({ schemaVersion: 1 }),
      inspectDvdTitleDamageDecision: () => ({
        schemaVersion: 1,
        state: current.decision,
        current,
        latest: current,
        currentIdentities: {},
      }),
      recordDvdTitleDamageAcceptanceWithdrawalPreviewDecision: () =>
        undefined,
      withdrawDvdTitleDamageAcceptance: (
        input: RecordDvdTitleDamageAcceptanceWithdrawalInput,
      ) => {
        if (options.failure === "stale") {
          throw new StaleDvdTitleDamageAcceptanceWithdrawalError({
            state: "withdrawn",
            decisionId: withdrawn.id,
          });
        }
        if (options.failure === "conflict") {
          throw new MutationKeyConflictError();
        }
        const semanticInput = JSON.stringify(input);
        const previous = mutationResults.get(input.mutationKey);
        if (previous !== undefined) {
          if (previous.semanticInput !== semanticInput) {
            throw new MutationKeyConflictError();
          }
          return previous.decision;
        }
        const decision = {
          ...withdrawn,
          acceptedDecisionId: input.acceptedDecisionId,
          operator: input.operator,
          snapshot: { ...accepted.snapshot, affectedWork },
          recordedAt: new Date("2026-10-28T08:01:00.000Z"),
        };
        mutationResults.set(input.mutationKey, { semanticInput, decision });
        return decision;
      },
    },
    encodeJobs: {
      listActiveForDiscSelections: () => affectedWork,
    },
    close: () => undefined,
  } as unknown as DataAccess;
  return fake;
}

function request(path: string, body: unknown) {
  return new Request(`https://operator.example${path}`, {
    method: "POST",
    headers: {
      Host: "operator.example",
      Origin: "https://operator.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const cliIo = (options: Parameters<typeof access>[0] = {}) => ({
  openAccess: () => access(options),
  readStdin: () => "",
  readFile: () => "",
});

function cliFailure(
  input: Record<string, unknown>,
  options: Parameters<typeof access>[0],
) {
  try {
    runDvdTitleDamageAcceptanceWithdrawal([
      "withdraw-damage",
      archiveId,
      "--key",
      mutationKey,
      "--json",
      JSON.stringify(input),
    ], cliIo(options));
  } catch (error) {
    if (error instanceof CommandFailure) return error;
    throw error;
  }
  throw new Error("Expected the withdrawal command to fail");
}

it("keeps withdrawal preflight aligned through web and JSON CLI", async () => {
  const web = await createDvdTitleDamageAcceptanceWithdrawalPreviewRoute(
    request(
      `/api/catalog-reviews/${archiveId}/title-damage-acceptance-withdrawal-preview`,
      { acceptedDecisionId },
    ),
    archiveId,
    access,
    () => "https://operator.example",
  );
  expect(web.status).toBe(200);
  const webResult = await web.json() as Record<string, unknown>;
  const cliResult = runDvdTitleDamageAcceptanceWithdrawal([
    "preview-withdrawal",
    archiveId,
    "--accepted-decision-id",
    acceptedDecisionId,
  ], cliIo()) as Record<string, unknown>;
  expect({ ...cliResult, previewToken: null }).toEqual({
    ...webResult,
    previewToken: null,
  });
  expect(cliResult).toMatchObject({
    available: true,
    acceptedDecision: { id: acceptedDecisionId },
    affectedWork,
    effects: {
      queuedClaimsBlocked: true,
      runningWorkContinues: true,
      existingOutputsChanged: false,
    },
  });
});

it("keeps withdrawal mutation aligned through web and JSON CLI", async () => {
  const input = {
    operator: "Synthetic withdrawal operator",
    previewToken,
    acceptedDecisionId,
  };
  const sharedAccess = access();
  const getSharedAccess = () => sharedAccess;
  const web = await createDvdTitleDamageAcceptanceWithdrawalRoute(
    request(
      `/api/catalog-reviews/${archiveId}/title-damage-acceptance-withdrawal`,
      { ...input, mutationKey },
    ),
    archiveId,
    getSharedAccess,
    () => "https://operator.example",
  );
  expect(web.status).toBe(200);
  const webResult = await web.json();
  const replay = await createDvdTitleDamageAcceptanceWithdrawalRoute(
    request(
      `/api/catalog-reviews/${archiveId}/title-damage-acceptance-withdrawal`,
      { ...input, mutationKey },
    ),
    archiveId,
    getSharedAccess,
    () => "https://operator.example",
  );
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(webResult);
  const cliResult = runDvdTitleDamageAcceptanceWithdrawal([
    "withdraw-damage",
    archiveId,
    "--key",
    mutationKey,
    "--json",
    JSON.stringify(input),
  ], cliIo());
  expect(cliResult).toEqual(webResult);
  expect(cliResult).toMatchObject({
    decision: {
      decision: "withdrawn",
      acceptedDecisionId,
    },
    affectedWork,
    queuedClaimsBlocked: true,
    runningWorkContinues: true,
    existingOutputsChanged: false,
  });
});

it("keeps already-withdrawn preflight reasons aligned", async () => {
  const openWithdrawnAccess = () => access({ currentState: "withdrawn" });
  const web = await createDvdTitleDamageAcceptanceWithdrawalPreviewRoute(
    request(
      `/api/catalog-reviews/${archiveId}/title-damage-acceptance-withdrawal-preview`,
      { acceptedDecisionId },
    ),
    archiveId,
    openWithdrawnAccess,
    () => "https://operator.example",
  );
  const webResult = await web.json();
  const cliResult = runDvdTitleDamageAcceptanceWithdrawal([
    "preview-withdrawal",
    archiveId,
    "--accepted-decision-id",
    acceptedDecisionId,
  ], cliIo({ currentState: "withdrawn" }));
  expect(cliResult).toEqual(webResult);
  expect(cliResult).toMatchObject({
    available: false,
    action: { reasons: [{ code: "ACCEPTANCE_WITHDRAWN" }] },
  });
});

it.each([
  {
    name: "stale event",
    options: { failure: "stale" as const },
    status: 409,
    code: "STALE_TITLE_DAMAGE_ACCEPTANCE_WITHDRAWAL",
  },
  {
    name: "changed-input mutation-key conflict",
    options: { failure: "conflict" as const },
    status: 409,
    code: "MUTATION_KEY_CONFLICT",
  },
])("keeps $name failures aligned", async ({ options, status, code }) => {
  const input = {
    operator: "Synthetic withdrawal operator",
    previewToken,
    acceptedDecisionId,
  };
  const web = await createDvdTitleDamageAcceptanceWithdrawalRoute(
    request(
      `/api/catalog-reviews/${archiveId}/title-damage-acceptance-withdrawal`,
      { ...input, mutationKey },
    ),
    archiveId,
    () => access(options),
    () => "https://operator.example",
  );
  expect(web.status).toBe(status);
  const problem = await web.json() as {
    error: { code: string; current?: unknown };
  };
  const cli = cliFailure(input, options);
  expect(cli.code).toBe(problem.error.code);
  expect(cli.code).toBe(code);
  expect(cli.details?.current).toEqual(problem.error.current);
});
