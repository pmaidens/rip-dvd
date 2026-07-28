import type { ParsedLegacyJob } from "./legacy-sidecars.js";

export function legacyJobLogicalKey(
  fingerprint: string,
  job: ParsedLegacyJob,
): string {
  return `${fingerprint}\0${job.sourceKey}\0${job.profileKey}`;
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
