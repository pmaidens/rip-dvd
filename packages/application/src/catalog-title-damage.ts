import {
  RecordNotFoundError,
  type DataAccess,
  type OriginalDiscArchiveId,
} from "@rip-dvd/data-access";

export class InvalidCatalogTitleDamageInputError extends Error {}

export class StaleCatalogTitleDamageCursorError extends Error {
  readonly code = "TITLE_DAMAGE_CURSOR_STALE";

  constructor(
    readonly current: {
      checkpointRevision: number | null;
      assessmentIdentity: string | null;
    },
  ) {
    super("The Title Damage Assessment cursor belongs to different evidence.");
  }
}

type TitleDamageCursor = readonly [
  "dvd-title-damage-page-v1",
  string,
  number,
  string,
  string,
  string,
  number,
];

function parseCursor(value: string | undefined): TitleDamageCursor | null {
  if (value === undefined) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(decoded) || decoded.length !== 7 ||
      decoded[0] !== "dvd-title-damage-page-v1" ||
      typeof decoded[1] !== "string" ||
      !Number.isSafeInteger(decoded[2]) || Number(decoded[2]) < 1 ||
      typeof decoded[3] !== "string" ||
      typeof decoded[4] !== "string" ||
      typeof decoded[5] !== "string" ||
      !Number.isSafeInteger(decoded[6]) || Number(decoded[6]) < 1 ||
      Buffer.from(JSON.stringify(decoded)).toString("base64url") !== value
    ) {
      throw new Error();
    }
    return decoded as unknown as TitleDamageCursor;
  } catch {
    throw new InvalidCatalogTitleDamageInputError(
      "Invalid Title Damage Assessment cursor.",
    );
  }
}

export function inspectCatalogTitleDamage(
  access: DataAccess,
  archiveId: string,
  options: { limit?: number; cursor?: string } = {},
) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(archiveId) ||
    (options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 1 ||
        options.limit > 100)) ||
    (options.cursor !== undefined &&
      (options.cursor.length === 0 || options.cursor.length > 2048))
  ) {
    throw new InvalidCatalogTitleDamageInputError(
      "Invalid Title Damage Assessment arguments.",
    );
  }
  const cursor = parseCursor(options.cursor);
  const id = archiveId as OriginalDiscArchiveId;
  const result = access.readConsistentSnapshot((snapshot) => {
    const archive = snapshot.catalog.listOriginalDiscArchives({ ids: [id] })[0];
    if (archive === undefined) {
      throw new RecordNotFoundError("Original Disc Archive", archiveId);
    }
    return snapshot.dvdTitleDamageAssessments.inspect(id);
  });
  const assessment = result.assessment;
  const current = {
    checkpointRevision: result.checkpoint?.manifestRevision ?? null,
    assessmentIdentity: result.currentAssessmentIdentity,
  };
  if (assessment === null) {
    if (cursor !== null) throw new StaleCatalogTitleDamageCursorError(current);
    return {
      schemaVersion: 1,
      originalDiscArchiveId: archiveId,
      state: result.state,
      checkpointRevision: current.checkpointRevision,
      assessmentIdentity: null,
      currentAssessmentIdentity: null,
      createdAt: null,
      items: [],
      itemOffset: 0,
      truncated: false,
      nextCursor: null,
      unknownTitleImpact: null,
      sourceContinuity: null,
      unattributedSourceContinuityRisk: null,
      noTitleMissingSourceProved: false,
      unavailableReasons: result.unavailableReasons,
    };
  }
  const assessmentIsCurrent = result.state === "current" &&
    result.currentAssessmentIdentity === assessment.id &&
    result.checkpoint?.manifestId === assessment.checkpoint.manifestId &&
    result.checkpoint.manifestRevision ===
      assessment.checkpoint.manifestRevision &&
    result.checkpoint.manifestDigest === assessment.checkpoint.manifestDigest;
  if (
    cursor !== null &&
    (!assessmentIsCurrent ||
      cursor[1] !== archiveId ||
      cursor[2] !== assessment.checkpoint.manifestRevision ||
      cursor[3] !== assessment.checkpoint.manifestId ||
      cursor[4] !== assessment.checkpoint.manifestDigest ||
      cursor[5] !== assessment.id)
  ) {
    throw new StaleCatalogTitleDamageCursorError(current);
  }
  if (!assessmentIsCurrent) {
    return {
      schemaVersion: 1,
      originalDiscArchiveId: archiveId,
      state: result.state,
      checkpointRevision: assessment.checkpoint.manifestRevision,
      assessmentIdentity: assessment.id,
      currentAssessmentIdentity: result.currentAssessmentIdentity,
      createdAt: assessment.createdAt.toISOString(),
      items: [],
      itemOffset: 0,
      truncated: false,
      nextCursor: null,
      unknownTitleImpact: assessment.unknownTitleImpact,
      sourceContinuity: assessment.sourceContinuity,
      unattributedSourceContinuityRisk:
        assessment.unattributedSourceContinuityRisk,
      noTitleMissingSourceProved: assessment.noTitleMissingSourceProved,
      unavailableReasons: result.unavailableReasons,
    };
  }
  const offset = cursor === null ? 0 : cursor[6];
  if (cursor !== null && offset >= assessment.items.length) {
    throw new InvalidCatalogTitleDamageInputError(
      "Title Damage Assessment cursor is outside the evidence set.",
    );
  }
  const items = assessment.items.slice(offset, offset + (options.limit ?? 20));
  const nextOffset = offset + items.length;
  const truncated = nextOffset < assessment.items.length;
  const nextCursor = truncated
    ? Buffer.from(JSON.stringify([
      "dvd-title-damage-page-v1",
      archiveId,
      assessment.checkpoint.manifestRevision,
      assessment.checkpoint.manifestId,
      assessment.checkpoint.manifestDigest,
      assessment.id,
      nextOffset,
    ] satisfies TitleDamageCursor)).toString("base64url")
    : null;
  return {
    schemaVersion: 1,
    originalDiscArchiveId: archiveId,
    state: result.state,
    checkpointRevision: assessment.checkpoint.manifestRevision,
    assessmentIdentity: assessment.id,
    currentAssessmentIdentity: result.currentAssessmentIdentity,
    createdAt: assessment.createdAt.toISOString(),
    items,
    itemOffset: offset,
    truncated,
    nextCursor,
    unknownTitleImpact: assessment.unknownTitleImpact,
    sourceContinuity: assessment.sourceContinuity,
    unattributedSourceContinuityRisk:
      assessment.unattributedSourceContinuityRisk,
    noTitleMissingSourceProved: assessment.noTitleMissingSourceProved,
    unavailableReasons: result.unavailableReasons,
  };
}
