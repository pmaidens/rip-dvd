import { presentKeptFailedEncodeOutput } from "./encode-output-keep-record.js";
import { canonicalPublicationJson, RecordNotFoundError, type DataAccess, type EncodeOutputKeepInput,
  type KeptFailedEncodeOutput } from "@rip-dvd/data-access";
import { canonicalEncodeOutputArtifactIdentity, type EncodeOutputMediaProbe } from "./encode-output-inspection.js";
import { EncodeOutputKeepEvidenceChangedError, orderedKeepBlockers, prepareEncodeOutputKeepReview, previewEncodeOutputKeep,
  type EncodeOutputKeepPreflight } from "./encode-output-keep-preflight.js";
import { parseMutationKey } from "./mutation-key.js";

export class InvalidEncodeOutputKeepInputError extends Error {
  constructor() {
    super("Keep requires an exact validationIdentity, previewToken, explicit acknowledgement and mutation key.");
    this.name = "InvalidEncodeOutputKeepInputError";
  }
}

export class EncodeOutputKeepRejectedError extends Error {
  constructor(readonly current: EncodeOutputKeepPreflight | null, readonly reasonCode = "KEEP_PREFLIGHT_STALE") {
    super("Keep rejected. Review the current failed Encode Output evidence again.");
    this.name = "EncodeOutputKeepRejectedError";
  }
}

export async function keepFailedEncodeOutput(
  access: DataAccess, artifactIdentityInput: unknown, raw: unknown, mediaProbe?: EncodeOutputMediaProbe,
) {
  const artifactIdentity = canonicalEncodeOutputArtifactIdentity(artifactIdentityInput);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new InvalidEncodeOutputKeepInputError();
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["mutationKey", "validationIdentity", "previewToken", "acknowledged"].includes(key)) ||
      body.acknowledged !== true || typeof body.validationIdentity !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.validationIdentity) ||
      typeof body.previewToken !== "string" || !/^encode-output-keep-preview-v1\.[a-f0-9]{64}$/.test(body.previewToken)) {
    throw new InvalidEncodeOutputKeepInputError();
  }
  const input: EncodeOutputKeepInput = { artifactIdentity, validationIdentity: body.validationIdentity.toLowerCase(),
    previewToken: body.previewToken, acknowledged: true, mutationKey: parseMutationKey(body.mutationKey) };
  const result = (record: KeptFailedEncodeOutput) => ({ schemaVersion: 1 as const, kept: presentKeptFailedEncodeOutput(record)! });
  const replay = access.encodeOutputKeeps.replay(input);
  if (replay !== null) return result(replay);
  try {
    const proof = await prepareEncodeOutputKeepReview(access, artifactIdentity, { previewToken: input.previewToken }, mediaProbe);
    const concurrentReplay = access.encodeOutputKeeps.replay(input);
    if (concurrentReplay !== null) return result(concurrentReplay);
    const { preview } = proof;
    if (preview.current.validationIdentity !== input.validationIdentity) {
      throw new EncodeOutputKeepRejectedError({ ...preview, eligible: false, previewToken: null,
        blockers: orderedKeepBlockers([...preview.blockers, { code: "OUTPUT_VALIDATION_CHANGED",
          message: "The supplied validation identity does not match the reviewed failed output." }]) }, "OUTPUT_VALIDATION_CHANGED");
    }
    if (!preview.eligible) {
      throw new EncodeOutputKeepRejectedError(preview, preview.blockers[0]?.code ?? "KEEP_PREFLIGHT_STALE");
    }
    return result(access.encodeOutputKeeps.record(input, {
      encodeJobId: preview.artifact.provenance.encodeJobId, evidenceJson: canonicalPublicationJson(preview),
    }, proof.assertCurrent));
  } catch (error) {
    const concurrentReplay = access.encodeOutputKeeps.replay(input);
    if (concurrentReplay !== null) return result(concurrentReplay);
    if (error instanceof EncodeOutputKeepRejectedError) throw error;
    if (!(error instanceof EncodeOutputKeepEvidenceChangedError) && !(error instanceof RecordNotFoundError)) throw error;
    let current: EncodeOutputKeepPreflight | null = null;
    try { current = await previewEncodeOutputKeep(access, artifactIdentity, { previewToken: input.previewToken }, mediaProbe); }
    catch (refreshError) { if (!(refreshError instanceof RecordNotFoundError)) throw refreshError; }
    throw new EncodeOutputKeepRejectedError(current, current?.blockers[0]?.code ?? "OUTPUT_AUTHORITY_CHANGED");
  }
}

export type EncodeOutputKeepResult = Awaited<ReturnType<typeof keepFailedEncodeOutput>>;
