import {
  RecordNotFoundError,
  dvdTitleDamageDecisionSelectionIds,
  type DataAccess,
  type DiscSelectionId,
  type DvdTitleDamageDecisionId,
  type EncodeJobId,
  type EncodeJobStatus,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { serializeDvdTitleDamageDecision } from
  "./dvd-title-damage-acceptance.js";
import {
  createDvdTitleDamageAcceptanceWithdrawalPreviewToken,
  isDvdTitleDamageAcceptanceWithdrawalPreviewToken,
} from "./dvd-title-damage-acceptance-withdrawal-preview-token.js";
import { parseRequiredText } from "./input-validation.js";
import { parseMutationKey } from "./mutation-key.js";

export class InvalidDvdTitleDamageAcceptanceWithdrawalInputError
  extends Error {}

const invalidInput = (message: string) =>
  new InvalidDvdTitleDamageAcceptanceWithdrawalInputError(message);

function inputRecord(value: unknown, allowed: readonly string[]) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidDvdTitleDamageAcceptanceWithdrawalInputError(
      "Title Damage Acceptance withdrawal input must be an object.",
    );
  }
  const record = value as Record<string, unknown>;
  const allowedFields = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedFields.has(key))) {
    throw new InvalidDvdTitleDamageAcceptanceWithdrawalInputError(
      "Title Damage Acceptance withdrawal input contains an unknown field.",
    );
  }
  return record;
}

function previewInput(value: unknown) {
  const record = inputRecord(value, ["acceptedDecisionId"]);
  return {
    acceptedDecisionId: parseRequiredText(
      record.acceptedDecisionId,
      "acceptedDecisionId",
      invalidInput,
    ) as DvdTitleDamageDecisionId,
  };
}

function withdrawalInput(value: unknown) {
  const record = inputRecord(value, [
    "mutationKey",
    "operator",
    "previewToken",
    "acceptedDecisionId",
  ]);
  if (!isDvdTitleDamageAcceptanceWithdrawalPreviewToken(record.previewToken)) {
    throw new InvalidDvdTitleDamageAcceptanceWithdrawalInputError(
      "A valid Title Damage Acceptance withdrawal preview token is required.",
    );
  }
  return {
    mutationKey: parseMutationKey(record.mutationKey),
    operator: parseRequiredText(record.operator, "operator", invalidInput),
    previewToken: record.previewToken,
    acceptedDecisionId: parseRequiredText(
      record.acceptedDecisionId,
      "acceptedDecisionId",
      invalidInput,
    ) as DvdTitleDamageDecisionId,
  };
}

function affectedWorkView(job: {
  id: EncodeJobId;
  discSelectionId: DiscSelectionId;
  status: EncodeJobStatus;
}) {
  return {
    id: job.id,
    discSelectionId: job.discSelectionId,
    status: job.status,
  };
}

export function previewDvdTitleDamageAcceptanceWithdrawal(
  access: DataAccess,
  originalDiscArchiveId: OriginalDiscArchiveId,
  value: unknown,
) {
  const input = previewInput(value);
  const plan = access.readConsistentSnapshot((snapshot) => {
    const archive = snapshot.catalog.listOriginalDiscArchives({
      ids: [originalDiscArchiveId],
    })[0];
    if (archive === undefined) {
      throw new RecordNotFoundError(
        "Original Disc Archive",
        originalDiscArchiveId,
      );
    }
    const evidence = snapshot.catalog.findDvdArchiveEvidenceHeader(
      originalDiscArchiveId,
    );
    const inspection = snapshot.catalog.inspectDvdTitleDamageDecision(
      originalDiscArchiveId,
    );
    const accepted = inspection.current?.decision === "accepted"
      ? inspection.current
      : null;
    const jobs = accepted === null
      ? []
      : snapshot.encodeJobs.listActiveForDiscSelections({
        discSelectionIds: dvdTitleDamageDecisionSelectionIds(accepted),
        limit: null,
      }).filter((job) => job.status === "queued" || job.status === "running");
    return { evidence, inspection, accepted, jobs };
  });
  const acceptedDecision = plan.accepted === null
    ? null
    : serializeDvdTitleDamageDecision(plan.accepted);
  const affectedWork = plan.jobs.map(affectedWorkView)
    .sort((left, right) => left.id.localeCompare(right.id));
  const reasons = plan.evidence === null
    ? [{
      code: "UNSUPPORTED_EVIDENCE_FORMAT" as const,
      message:
        "Title Damage Acceptance withdrawal requires dvd-recovery-evidence-v1.",
    }]
    : plan.inspection.state === "withdrawn"
    ? [{
      code: "ACCEPTANCE_WITHDRAWN" as const,
      message: "The current Title Damage Acceptance is already withdrawn.",
    }]
    : plan.inspection.state === "expired"
    ? [{
      code: "ACCEPTANCE_EXPIRED" as const,
      message: "The latest Title Damage Acceptance is no longer current.",
    }]
    : plan.inspection.state === "not_required"
    ? [{
      code: "ACCEPTANCE_NOT_REQUIRED" as const,
      message: "The current exact set did not require damage acceptance.",
    }]
    : plan.accepted === null
    ? [{
      code: "ACCEPTANCE_NOT_RECORDED" as const,
      message: "No current Title Damage Acceptance can be withdrawn.",
    }]
    : plan.accepted.id !== input.acceptedDecisionId
    ? [{
      code: "ACCEPTANCE_CHANGED" as const,
      message: "The requested Title Damage Acceptance decision is not current.",
      details: { currentAcceptedDecisionId: plan.accepted.id },
    }]
    : [];
  const available = reasons.length === 0 && plan.accepted !== null;
  const previewToken = available
    ? createDvdTitleDamageAcceptanceWithdrawalPreviewToken()
    : null;
  if (previewToken !== null && plan.accepted !== null) {
    access.catalog.recordDvdTitleDamageAcceptanceWithdrawalPreviewDecision({
      previewToken,
      originalDiscArchiveId,
      acceptedDecisionId: plan.accepted.id,
      affectedWork,
    });
  }
  return {
    schemaVersion: 1 as const,
    evidenceFormat: plan.evidence === null
      ? null
      : "dvd-recovery-evidence-v1" as const,
    available,
    previewToken,
    action: {
      available,
      reasons,
      expectedInputs: available
        ? ["mutationKey", "operator", "previewToken", "acceptedDecisionId"]
        : ["acceptedDecisionId"],
    },
    acceptedDecision,
    affectedWork,
    effects: {
      queuedClaimsBlocked: available,
      runningWorkContinues: true,
      existingOutputsChanged: false,
    },
  };
}

export function withdrawDvdTitleDamageAcceptance(
  access: DataAccess,
  originalDiscArchiveId: OriginalDiscArchiveId,
  value: unknown,
) {
  const input = withdrawalInput(value);
  const decision = access.catalog.withdrawDvdTitleDamageAcceptance({
    ...input,
    originalDiscArchiveId,
  });
  return {
    schemaVersion: 1 as const,
    decision: serializeDvdTitleDamageDecision(decision),
    affectedWork: decision.snapshot.affectedWork,
    queuedClaimsBlocked: true as const,
    runningWorkContinues: true as const,
    existingOutputsChanged: false as const,
  };
}

export type DvdTitleDamageAcceptanceWithdrawalPreview = ReturnType<
  typeof previewDvdTitleDamageAcceptanceWithdrawal
>;
