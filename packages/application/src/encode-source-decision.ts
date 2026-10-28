import {
  DvdRecoveryEvidenceEncodingUnavailableError,
  type DataAccess, type DiscSelectionId, type EncodeSourceDecision,
} from "@rip-dvd/data-access";
import { defaultArchiveImageOwnership, type ArchiveImageOwnership } from "@rip-dvd/worker-runtime";
import { describeEncodingReadiness, orderEncodingReadinessReasons, type EncodingReadiness, type EncodingReadinessReason } from "./encoding-readiness.js";

export class InvalidEncodeSourceDecisionError extends Error {}

export function parseEncodeSourceDecision(value: unknown): EncodeSourceDecision | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidEncodeSourceDecisionError();
  const input = value as Record<string, unknown>;
  const names = ["selectionIdentity", "titleIdentityId", "titleIdentityObservationId", "reviewSetIdentity",
    "catalogMappingProjectionId", "assessmentIdentity", "acceptanceIdentity", "reviewedContentIdentity"] as const;
  if (Object.keys(input).length !== names.length + 1 || names.some((name) =>
    input[name] !== null && (typeof input[name] !== "string" || input[name].length === 0 || input[name].length > 256)) ||
    typeof input.selectionIdentity !== "string") throw new InvalidEncodeSourceDecisionError();
  const checkpoint = input.checkpoint as EncodeSourceDecision["checkpoint"];
  if (checkpoint !== null && (typeof checkpoint !== "object" || Array.isArray(checkpoint) ||
    Object.keys(checkpoint).length !== 3 || typeof checkpoint.manifestId !== "string" || !checkpoint.manifestId || checkpoint.manifestId.length > 256 ||
    !Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1 ||
    typeof checkpoint.manifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.manifestDigest))) throw new InvalidEncodeSourceDecisionError();
  return { checkpoint: checkpoint === null ? null : {
    manifestId: checkpoint.manifestId, revision: checkpoint.revision, manifestDigest: checkpoint.manifestDigest,
  }, ...Object.fromEntries(names.map((name) => [name, input[name]])) } as EncodeSourceDecision;
}

export class EncodeSourceDecisionRejectedError extends Error {
  constructor(
    readonly code: string,
    readonly current: { readiness: EncodingReadiness; expectedSourceDecision: EncodeSourceDecision | null },
    readonly blockingReasons: readonly EncodingReadinessReason[],
  ) { super("Encode source decision is unavailable or stale."); }
}

/** Prepare checkpoint proof under shared image ownership, then recheck the same
 * readiness decision within the Encode mutation's immediate transaction. */
export async function withEncodeSourceDecision<T>(
  access: DataAccess,
  discSelectionId: DiscSelectionId,
  expected: EncodeSourceDecision | undefined,
  originalsLibraryPath: string,
  mutate: (assertSourceDecision?: () => void) => T,
  ownership: ArchiveImageOwnership = defaultArchiveImageOwnership,
): Promise<T> {
  const selection = access.catalog.listDiscSelections({ ids: [discSelectionId], includeHistorical: true })[0];
  if (selection === undefined) return mutate();
  const id = selection.originalDiscArchiveId;
  const read = (verified = false, failure: string | null = null) => access.readConsistentSnapshot((snapshot) =>
    describeEncodingReadiness(snapshot, id, ownership, originalsLibraryPath, verified, failure));
  const initial = read();
  if (!initial.applicable) return mutate();
  let verified = false;
  let checkpointFailure: string | null = null;
  let latest = initial;
  const assertSourceDecision = () => {
    const readiness = read(verified, checkpointFailure);
    if (!readiness.applicable) throw new Error("Encode source evidence format changed");
    latest = readiness;
    const content = readiness.selections.find((item) => item.discSelectionId === discSelectionId);
    const currentDecision = content?.expectedSourceDecision ?? null;
    const current = { readiness, expectedSourceDecision: currentDecision };
    const stale = expected === undefined || JSON.stringify(expected) !== JSON.stringify(currentDecision);
    const reasons = [...readiness.blockingReasons];
    if (stale) reasons.unshift({ code: "SOURCE_DECISION_STALE", message: "Expected current checkpoint, selection, assessment and applicable acceptance identities are required.", details: {} });
    if (stale || reasons.length > 0) throw new EncodeSourceDecisionRejectedError(
      stale ? "STALE_ENCODE_SOURCE_DECISION" : "ENCODE_SOURCE_UNAVAILABLE", current,
      orderEncodingReadinessReasons([...reasons, ...readiness.admissionReasons.map((reason) => ({ ...reason, details: {} }))]),
    );
  };
  const commit = () => {
    try { return mutate(assertSourceDecision); }
    catch (error) {
      if (error instanceof DvdRecoveryEvidenceEncodingUnavailableError) throw new EncodeSourceDecisionRejectedError(
        error.code, { readiness: latest, expectedSourceDecision: latest.selections.find((item) => item.discSelectionId === discSelectionId)?.expectedSourceDecision ?? null },
        latest.admissionReasons.map((reason) => ({ ...reason, details: {} })),
      );
      throw error;
    }
  };
  // Rejections still run within the same transaction and do not need to read image bytes.
  if (!initial.sourceReady || expected === undefined) return commit();
  let result: T | undefined;
  let committed = false;
  try {
    await access.withDvdCheckpoint(id, ownership, async () => undefined, () => {
      verified = true;
      result = commit(); committed = true;
    });
  } catch (error) {
    if (verified || error instanceof EncodeSourceDecisionRejectedError) throw error;
    checkpointFailure = error instanceof Error && "code" in error ? String(error.code) : "DVD_EVIDENCE_UNAVAILABLE";
    return commit();
  }
  if (!committed) { checkpointFailure = "DVD_EVIDENCE_NOT_RECORDED"; return commit(); }
  return result!;
}
