import {
  MAX_DVD_TITLES,
  type DataAccess,
  type DiscSelectionId,
  type DvdTitleDamageDecision,
  type DvdTitleIdentityId,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

import { isDvdTitleDamageAcceptancePreviewToken } from
  "./dvd-title-damage-acceptance-preview-token.js";
import { parseRequiredText } from "./input-validation.js";
import { parseMutationKey } from "./mutation-key.js";

export class InvalidDvdTitleDamageAcceptanceInputError extends Error {}

const invalidInput = (message: string) =>
  new InvalidDvdTitleDamageAcceptanceInputError(message);

function digest(value: unknown, name: string): string {
  const parsed = parseRequiredText(value, name, invalidInput, 64);
  if (!/^[0-9a-f]{64}$/.test(parsed)) {
    throw new InvalidDvdTitleDamageAcceptanceInputError(
      `${name} must be a lowercase SHA-256 digest.`,
    );
  }
  return parsed;
}

function excludedTitleIdentityIds(value: unknown): DvdTitleIdentityId[] {
  if (!Array.isArray(value) || value.length > MAX_DVD_TITLES) {
    throw new InvalidDvdTitleDamageAcceptanceInputError(
      "excludedTitleIdentityIds must contain the complete preview exclusions.",
    );
  }
  const ids = value.map((candidate) =>
    parseRequiredText(
      candidate,
      "Excluded Title Identity",
      invalidInput,
    ) as DvdTitleIdentityId
  ).sort();
  if (new Set(ids).size !== ids.length) {
    throw new InvalidDvdTitleDamageAcceptanceInputError(
      "Excluded Title Identities must be unique.",
    );
  }
  return ids;
}

function mainFeatureResolutions(value: unknown): Array<{
  discSelectionId: DiscSelectionId;
  titleIdentityId: DvdTitleIdentityId;
}> {
  if (!Array.isArray(value) || value.length > MAX_DVD_TITLES) {
    throw new InvalidDvdTitleDamageAcceptanceInputError(
      "mainFeatureResolutions must contain the complete preview resolutions.",
    );
  }
  const resolutions = value.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null ||
        Array.isArray(candidate)) {
      throw new InvalidDvdTitleDamageAcceptanceInputError(
        "Each main-feature resolution must identify one Disc Selection and Title Identity.",
      );
    }
    const record = candidate as Record<string, unknown>;
    if (Object.keys(record).some((key) =>
      key !== "discSelectionId" && key !== "titleIdentityId"
    )) {
      throw new InvalidDvdTitleDamageAcceptanceInputError(
        "A main-feature resolution contains an unknown field.",
      );
    }
    return {
      discSelectionId: parseRequiredText(
        record.discSelectionId,
        "Disc Selection ID",
        invalidInput,
      ) as DiscSelectionId,
      titleIdentityId: parseRequiredText(
        record.titleIdentityId,
        "Title Identity ID",
        invalidInput,
      ) as DvdTitleIdentityId,
    };
  }).sort((left, right) =>
    left.discSelectionId.localeCompare(right.discSelectionId)
  );
  if (new Set(resolutions.map(({ discSelectionId }) => discSelectionId)).size !==
      resolutions.length) {
    throw new InvalidDvdTitleDamageAcceptanceInputError(
      "Each main-feature Disc Selection may be resolved only once.",
    );
  }
  return resolutions;
}

function parseInput(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidDvdTitleDamageAcceptanceInputError(
      "Title Damage Acceptance input must be an object.",
    );
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "mutationKey",
    "operator",
    "previewToken",
    "checkpointRevision",
    "checkpointDigest",
    "assessmentIdentity",
    "reviewSetIdentity",
    "catalogMappingProjectionId",
    "reviewedContentIdentity",
    "excludedTitleIdentityIds",
    "mainFeatureResolutions",
    "damageAcknowledgement",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new InvalidDvdTitleDamageAcceptanceInputError(
      "Title Damage Acceptance input contains an unknown field.",
    );
  }
  if (!Number.isSafeInteger(record.checkpointRevision) ||
      (record.checkpointRevision as number) < 1) {
    throw new InvalidDvdTitleDamageAcceptanceInputError(
      "checkpointRevision must be a positive integer.",
    );
  }
  if (!isDvdTitleDamageAcceptancePreviewToken(record.previewToken)) {
    throw new InvalidDvdTitleDamageAcceptanceInputError(
      "A valid Title Damage Acceptance preview token is required.",
    );
  }
  if (record.damageAcknowledgement !== undefined &&
      typeof record.damageAcknowledgement !== "boolean") {
    throw new InvalidDvdTitleDamageAcceptanceInputError(
      "damageAcknowledgement must be boolean.",
    );
  }
  return {
    mutationKey: parseMutationKey(record.mutationKey),
    operator: parseRequiredText(record.operator, "operator", invalidInput),
    previewToken: record.previewToken,
    checkpoint: {
      revision: record.checkpointRevision as number,
      digest: digest(record.checkpointDigest, "checkpointDigest"),
    },
    assessmentIdentity: parseRequiredText(
      record.assessmentIdentity,
      "assessmentIdentity",
      invalidInput,
    ),
    reviewSetIdentity: digest(record.reviewSetIdentity, "reviewSetIdentity"),
    catalogMappingProjectionId: digest(
      record.catalogMappingProjectionId,
      "catalogMappingProjectionId",
    ),
    reviewedContentIdentity: digest(
      record.reviewedContentIdentity,
      "reviewedContentIdentity",
    ),
    excludedTitleIdentityIds: excludedTitleIdentityIds(
      record.excludedTitleIdentityIds,
    ),
    mainFeatureResolutions: mainFeatureResolutions(
      record.mainFeatureResolutions,
    ),
    damageAcknowledgement: record.damageAcknowledgement === true,
  };
}

export function serializeDvdTitleDamageDecision(
  decision: DvdTitleDamageDecision,
) {
  return {
    ...decision,
    catalogRevision: decision.catalogRevision.toISOString(),
    recordedAt: decision.recordedAt.toISOString(),
  };
}

export function acceptDvdTitleDamage(
  access: DataAccess,
  originalDiscArchiveId: OriginalDiscArchiveId,
  value: unknown,
) {
  const input = parseInput(value);
  return {
    schemaVersion: 1 as const,
    decision: serializeDvdTitleDamageDecision(
      access.catalog.recordDvdTitleDamageDecision({
      ...input,
      originalDiscArchiveId,
      }),
    ),
    encodingQueued: false as const,
    watchabilityProved: false as const,
    outputValidationWaived: false as const,
  };
}

export function inspectDvdTitleDamageDecision(
  access: DataAccess,
  originalDiscArchiveId: OriginalDiscArchiveId,
) {
  const inspection = access.catalog.inspectDvdTitleDamageDecision(
    originalDiscArchiveId,
  );
  const serialize = (decision: typeof inspection.latest) => decision === null
    ? null
    : serializeDvdTitleDamageDecision(decision);
  return {
    ...inspection,
    current: serialize(inspection.current),
    latest: serialize(inspection.latest),
  };
}
