import type { ParsedLegacyJob } from "./legacy-sidecars.js";

declare const legacyJobLogicalKeyBrand: unique symbol;

export type LegacyJobLogicalKey = string & {
  readonly [legacyJobLogicalKeyBrand]: true;
};

export interface LegacyJobLogicalIdentity {
  fingerprint: string;
  outputPath?: string;
  profileKey: string;
  sourceKey: string;
}

export function createLegacyJobLogicalKey(
  identity: LegacyJobLogicalIdentity,
): LegacyJobLogicalKey {
  const fields = [
    identity.fingerprint,
    identity.sourceKey,
    identity.profileKey,
    ...(identity.outputPath === undefined ? [] : [identity.outputPath]),
  ];
  if (fields.some((field) => field.length === 0 || field.includes("\0"))) {
    throw new Error("Legacy job logical identity contains an invalid field");
  }
  return fields.join("\0") as LegacyJobLogicalKey;
}

export function parseLegacyJobLogicalKey(
  logicalKey: string,
): LegacyJobLogicalIdentity | null {
  const fields = logicalKey.split("\0");
  if (
    (fields.length !== 3 && fields.length !== 4) ||
    fields.some((field) => field.length === 0)
  ) {
    return null;
  }
  const [fingerprint, sourceKey, profileKey, outputPath] = fields;
  return {
    fingerprint,
    ...(outputPath === undefined ? {} : { outputPath }),
    profileKey,
    sourceKey,
  };
}

export function legacyJobLogicalKey(
  fingerprint: string,
  job: ParsedLegacyJob,
): LegacyJobLogicalKey {
  return createLegacyJobLogicalKey({
    fingerprint,
    outputPath: job.outputPath,
    profileKey: job.profileKey,
    sourceKey: job.sourceKey,
  });
}

export function legacyJobSignature(job: ParsedLegacyJob): string {
  return JSON.stringify({
    kind: job.kind,
    label: job.label,
    mediaItemKind: job.mediaItemKind,
    mediaTitle: job.mediaTitle,
    outputPath: job.outputPath,
    preset: job.preset,
    profileKey: job.profileKey,
    sourceKey: job.sourceKey,
    titleNumber: job.titleNumber,
  });
}
