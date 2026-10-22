import { createHash } from "node:crypto";

import {
  classifyArchiveReadFailureEvidence,
  isArchiveReadFailureEvidenceConsistent,
} from "./archive-read-failure.js";
import { DomainInvariantError } from "./errors.js";
import type { DvdUnrecoveredSourceRange } from "./types.js";

export const DVD_SOURCE_VERIFICATION_POLICY_VERSION =
  "dvd-source-verification-v1" as const;
export const DVD_SOURCE_SAMPLE_BYTE_REPRESENTATION =
  "dvdcss-noflags-raw-sector-v1" as const;
export const DVD_SOURCE_SAMPLE_BAND_COUNT = 16;
export const DVD_SOURCE_SAMPLE_SECTOR_COUNT = 32;
export const DVD_SOURCE_SAMPLE_SECTOR_BYTES = 2_048;
export const DVD_SOURCE_SAMPLE_BYTE_COUNT =
  DVD_SOURCE_SAMPLE_SECTOR_COUNT * DVD_SOURCE_SAMPLE_SECTOR_BYTES;
export const DVD_SOURCE_VERIFICATION_MAX_BYTES = 1_048_576;
export const DVD_SOURCE_VERIFICATION_READ_DEADLINE_MS = 60_000;

const SAMPLE_DIGEST_DOMAIN = "rip-dvd:dvd-source-sample:v1\0";
const SAMPLE_MANIFEST_DIGEST_DOMAIN =
  "rip-dvd:dvd-source-sample-manifest:v1\0";

export interface DvdSourceSampleReference {
  bandIndex: number;
  startLba: number;
  sectorCount: typeof DVD_SOURCE_SAMPLE_SECTOR_COUNT;
  digest: string;
}

export interface DvdSourceSampleManifest {
  policyVersion: typeof DVD_SOURCE_VERIFICATION_POLICY_VERSION;
  byteRepresentation: typeof DVD_SOURCE_SAMPLE_BYTE_REPRESENTATION;
  sourceMetadataFingerprint: string;
  acceptedEndLbaExclusive: number;
  checkpointRevision: number;
  checkpointDigest: string;
  samples: readonly DvdSourceSampleReference[];
  manifestDigest: string;
}

export type DvdDiscVerificationOutcome =
  | "match"
  | "mismatch"
  | "inconclusive";

export type DvdDiscVerificationReasonCode =
  | "DISC_METADATA_MISMATCH"
  | "DISC_SAMPLE_MISMATCH"
  | "DISC_SAMPLE_COVERAGE_INCOMPLETE"
  | "DISC_SAMPLE_UNREADABLE"
  | "DISC_VERIFICATION_TIMEOUT"
  | "DISC_VERIFICATION_INTERRUPTED"
  | "DISC_INSERTION_CHANGED"
  | "DISC_CHECKPOINT_CHANGED"
  | "DISC_SAMPLE_MANIFEST_UNAVAILABLE";

export interface DvdDiscVerificationDiagnostic {
  category:
    | "unknown"
    | "medium_error"
    | "not_ready"
    | "unit_attention"
    | "hardware_error"
    | "transport_error"
    | "protection_error"
    | "out_of_range";
  classifierVersion: string;
  scsiStatus: number | null;
  hostStatus: number | null;
  driverStatus: number | null;
  senseResponseCode: number | null;
  senseKey: number | null;
  asc: number | null;
  ascq: number | null;
  informationLba: number | null;
}

export type DvdDiscVerificationSampleFinding =
  | {
      bandIndex: number;
      startLba: number;
      sectorCount: number;
      outcome: "match" | "mismatch";
      referenceDigest: string;
      observedDigest: string;
      diagnostic: null;
    }
  | {
      bandIndex: number;
      startLba: number;
      sectorCount: number;
      outcome: "unreadable";
      referenceDigest: string;
      observedDigest: null;
      diagnostic: DvdDiscVerificationDiagnostic;
    };

export class DvdSourceSampleManifestProjectionError
  extends DomainInvariantError {
  readonly code = "DVD_SOURCE_SAMPLE_MANIFEST_PROJECTION_CONFLICT" as const;

  constructor() {
    super(
      "DVD source sample manifest projection conflicts with publication evidence",
    );
    this.name = "DvdSourceSampleManifestProjectionError";
  }
}

export function dvdDiscVerificationInsertionIsCurrent(
  verification: {
    discInspectionId: string;
    detectedDiscId: string;
    mediaGeneration: string;
  },
  inspection: {
    id: string;
    isCurrent: boolean;
    status: string;
    detectedDiscId: string | null;
    mediaGeneration: string;
  } | null | undefined,
): boolean {
  return inspection !== null && inspection !== undefined &&
    inspection.id === verification.discInspectionId &&
    inspection.isCurrent &&
    inspection.status === "completed" &&
    inspection.detectedDiscId === verification.detectedDiscId &&
    inspection.mediaGeneration === verification.mediaGeneration;
}

export function dvdDiscVerificationCheckpointIsCurrent(
  verification: { checkpointRevision: number; checkpointDigest: string },
  checkpoint: { revision: number; digest: string } | null | undefined,
): boolean {
  return checkpoint !== null && checkpoint !== undefined &&
    checkpoint.revision === verification.checkpointRevision &&
    checkpoint.digest === verification.checkpointDigest;
}

const DVD_DISC_VERIFICATION_DIAGNOSTIC_CATEGORIES = new Set<
  DvdDiscVerificationDiagnostic["category"]
>([
  "unknown",
  "medium_error",
  "not_ready",
  "unit_attention",
  "hardware_error",
  "transport_error",
  "protection_error",
  "out_of_range",
]);

function optionalDiagnosticInteger(
  value: unknown,
  maximum: number,
): value is number | null {
  return value === null ||
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

/** Validates the shared SCSI diagnostic tuple and returns its canonical category. */
export function normalizeDvdDiscVerificationDiagnostic(
  candidate: {
    category: unknown;
    classifierVersion: unknown;
    scsiStatus: unknown;
    hostStatus: unknown;
    driverStatus: unknown;
    senseResponseCode: unknown;
    senseKey: unknown;
    asc: unknown;
    ascq: unknown;
    informationLba: unknown;
  },
  expected: { startLba: number; sectorCount: number },
  categoryEncoding: "normalized" | "read_failure_protocol" = "normalized",
): DvdDiscVerificationDiagnostic {
  if (
    typeof candidate.category !== "string" ||
    !DVD_DISC_VERIFICATION_DIAGNOSTIC_CATEGORIES.has(
      candidate.category as DvdDiscVerificationDiagnostic["category"],
    ) ||
    typeof candidate.classifierVersion !== "string" ||
    candidate.classifierVersion.length === 0 ||
    candidate.classifierVersion.length > 128 ||
    !optionalDiagnosticInteger(candidate.scsiStatus, 0xff) ||
    !optionalDiagnosticInteger(candidate.hostStatus, 0xffff) ||
    !optionalDiagnosticInteger(candidate.driverStatus, 0xffff) ||
    !optionalDiagnosticInteger(candidate.senseResponseCode, 0xff) ||
    !optionalDiagnosticInteger(candidate.senseKey, 0x0f) ||
    !optionalDiagnosticInteger(candidate.asc, 0xff) ||
    !optionalDiagnosticInteger(candidate.ascq, 0xff) ||
    !optionalDiagnosticInteger(
      candidate.informationLba,
      Number.MAX_SAFE_INTEGER,
    ) ||
    ((candidate.scsiStatus === null || candidate.hostStatus === null ||
      candidate.driverStatus === null) &&
      (candidate.scsiStatus !== null || candidate.hostStatus !== null ||
        candidate.driverStatus !== null)) ||
    (candidate.senseResponseCode === null &&
      (candidate.senseKey !== null || candidate.asc !== null ||
        candidate.ascq !== null || candidate.informationLba !== null)) ||
    (candidate.senseResponseCode !== null &&
      candidate.senseResponseCode !== 0x70 &&
      candidate.senseResponseCode !== 0x71 &&
      candidate.senseResponseCode !== 0x72 &&
      candidate.senseResponseCode !== 0x73) ||
    (candidate.asc === null) !== (candidate.ascq === null) ||
    (candidate.informationLba !== null &&
      (candidate.informationLba < expected.startLba ||
        candidate.informationLba >=
          expected.startLba + expected.sectorCount))
  ) {
    throw new DomainInvariantError(
      "DVD disc verification diagnostic is invalid",
    );
  }
  const diagnostic = candidate as DvdDiscVerificationDiagnostic;
  const classification = classifyArchiveReadFailureEvidence(diagnostic);
  const currentSense = diagnostic.senseResponseCode === 0x70 ||
    diagnostic.senseResponseCode === 0x72;
  const hasOutOfRangeEvidence = currentSense &&
    isArchiveReadFailureEvidenceConsistent({
      ...diagnostic,
      category: "out_of_range",
    });
  const normalizedCategory = hasOutOfRangeEvidence
    ? "out_of_range"
    : classification === "transport_error"
      ? "transport_error"
      : currentSense
        ? classification === "recognized_medium_error"
          ? "medium_error"
          : classification
        : "unknown";
  const encodedCategory = categoryEncoding === "read_failure_protocol" &&
      normalizedCategory === "medium_error"
    ? "unknown"
    : normalizedCategory;
  if (
    diagnostic.category !== encodedCategory ||
    categoryEncoding === "read_failure_protocol" &&
      normalizedCategory === "out_of_range"
  ) {
    throw new DomainInvariantError(
      "DVD disc verification diagnostic category is invalid",
    );
  }
  return { ...diagnostic, category: normalizedCategory };
}

function requireDigest(value: string, description: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new DomainInvariantError(
      `${description} must be a lowercase SHA-256 digest`,
    );
  }
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update(JSON.stringify(value))
    .digest("hex");
}

export function createDvdSourceSampleDigest(bytes: Uint8Array): string {
  if (bytes.byteLength !== DVD_SOURCE_SAMPLE_BYTE_COUNT) {
    throw new DomainInvariantError(
      `DVD source samples must contain ${DVD_SOURCE_SAMPLE_BYTE_COUNT} bytes`,
    );
  }
  return createHash("sha256")
    .update(SAMPLE_DIGEST_DOMAIN)
    .update(bytes)
    .digest("hex");
}

export function hasSuitableDvdSourceSampleContent(
  bytes: Uint8Array,
): boolean {
  if (bytes.byteLength !== DVD_SOURCE_SAMPLE_BYTE_COUNT) return false;
  const first = bytes[0];
  return bytes.some((byte) => byte !== first);
}

function sampleManifestPayload(
  manifest: Omit<DvdSourceSampleManifest, "manifestDigest">,
): unknown {
  return [
    manifest.policyVersion,
    manifest.byteRepresentation,
    manifest.sourceMetadataFingerprint,
    manifest.acceptedEndLbaExclusive,
    manifest.checkpointRevision,
    manifest.checkpointDigest,
    manifest.samples.map((sample) => [
      sample.bandIndex,
      sample.startLba,
      sample.sectorCount,
      sample.digest,
    ]),
  ];
}

export function createDvdSourceSampleManifestDigest(
  manifest: Omit<DvdSourceSampleManifest, "manifestDigest">,
): string {
  return digest(SAMPLE_MANIFEST_DIGEST_DOMAIN, sampleManifestPayload(manifest));
}

export function validateDvdSourceSampleManifest(
  manifest: DvdSourceSampleManifest,
): DvdSourceSampleManifest {
  if (
    manifest.policyVersion !== DVD_SOURCE_VERIFICATION_POLICY_VERSION ||
    manifest.byteRepresentation !== DVD_SOURCE_SAMPLE_BYTE_REPRESENTATION ||
    manifest.sourceMetadataFingerprint.length === 0 ||
    manifest.sourceMetadataFingerprint.length > 512 ||
    !Number.isSafeInteger(manifest.acceptedEndLbaExclusive) ||
    manifest.acceptedEndLbaExclusive <= 0 ||
    !Number.isSafeInteger(manifest.checkpointRevision) ||
    manifest.checkpointRevision <= 0 ||
    manifest.samples.length > DVD_SOURCE_SAMPLE_BAND_COUNT
  ) {
    throw new DomainInvariantError("DVD source sample manifest is invalid");
  }
  requireDigest(manifest.checkpointDigest, "DVD source checkpoint digest");
  const bands = new Set<number>();
  const addresses = new Set<number>();
  for (const sample of manifest.samples) {
    const bandStart = Math.floor(
      manifest.acceptedEndLbaExclusive * sample.bandIndex /
        DVD_SOURCE_SAMPLE_BAND_COUNT,
    );
    const bandEnd = Math.floor(
      manifest.acceptedEndLbaExclusive * (sample.bandIndex + 1) /
        DVD_SOURCE_SAMPLE_BAND_COUNT,
    );
    const midpointLba = sample.startLba +
      DVD_SOURCE_SAMPLE_SECTOR_COUNT / 2;
    if (
      !Number.isSafeInteger(sample.bandIndex) ||
      sample.bandIndex < 0 ||
      sample.bandIndex >= DVD_SOURCE_SAMPLE_BAND_COUNT ||
      bands.has(sample.bandIndex) ||
      addresses.has(sample.startLba) ||
      !Number.isSafeInteger(sample.startLba) ||
      sample.startLba < 0 ||
      sample.sectorCount !== DVD_SOURCE_SAMPLE_SECTOR_COUNT ||
      sample.startLba + sample.sectorCount >
        manifest.acceptedEndLbaExclusive ||
      midpointLba < bandStart || midpointLba >= bandEnd
    ) {
      throw new DomainInvariantError("DVD source sample reference is invalid");
    }
    requireDigest(sample.digest, "DVD source sample digest");
    bands.add(sample.bandIndex);
    addresses.add(sample.startLba);
  }
  requireDigest(manifest.manifestDigest, "DVD source sample manifest digest");
  const { manifestDigest, ...payload } = manifest;
  if (createDvdSourceSampleManifestDigest(payload) !== manifestDigest) {
    throw new DomainInvariantError(
      "DVD source sample manifest digest does not match its contents",
    );
  }
  return manifest;
}

function canonicalSourceSampleJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        ),
      );
    }
    return item;
  });
}

export function assertDvdSourceSampleManifestProjection(
  published: DvdSourceSampleManifest | null,
  projected: DvdSourceSampleManifest | null,
): void {
  if (published !== null) validateDvdSourceSampleManifest(published);
  if (projected !== null) validateDvdSourceSampleManifest(projected);
  if (
    canonicalSourceSampleJson(published) !==
      canonicalSourceSampleJson(projected)
  ) {
    throw new DvdSourceSampleManifestProjectionError();
  }
}

function overlapsUnrecoveredSource(
  startLba: number,
  sectorCount: number,
  ranges: readonly DvdUnrecoveredSourceRange[],
): boolean {
  const endLbaExclusive = startLba + sectorCount;
  return ranges.some((range) =>
    range.startLba < endLbaExclusive &&
    range.startLba + range.sectorCount > startLba
  );
}

/**
 * Returns deterministic candidate windows ordered nearest the band's midpoint.
 * A caller reads candidates until it finds nonuniform bytes. The midpoint of
 * every returned 32-sector window lies in the requested equal address band.
 */
export function dvdSourceSampleCandidates(input: {
  acceptedEndLbaExclusive: number;
  bandIndex: number;
  unrecoveredSourceRanges: readonly DvdUnrecoveredSourceRange[];
}): number[] {
  const { acceptedEndLbaExclusive, bandIndex, unrecoveredSourceRanges } = input;
  if (
    !Number.isSafeInteger(acceptedEndLbaExclusive) ||
    acceptedEndLbaExclusive < DVD_SOURCE_SAMPLE_SECTOR_COUNT ||
    !Number.isSafeInteger(bandIndex) ||
    bandIndex < 0 ||
    bandIndex >= DVD_SOURCE_SAMPLE_BAND_COUNT
  ) return [];
  const bandStart = Math.floor(
    acceptedEndLbaExclusive * bandIndex / DVD_SOURCE_SAMPLE_BAND_COUNT,
  );
  const bandEnd = Math.floor(
    acceptedEndLbaExclusive * (bandIndex + 1) /
      DVD_SOURCE_SAMPLE_BAND_COUNT,
  );
  const half = DVD_SOURCE_SAMPLE_SECTOR_COUNT / 2;
  const minimumStart = Math.max(0, bandStart - half + 1);
  const maximumStart = Math.min(
    acceptedEndLbaExclusive - DVD_SOURCE_SAMPLE_SECTOR_COUNT,
    bandEnd - half - 1,
  );
  if (minimumStart > maximumStart) return [];
  const target = Math.max(minimumStart, Math.min(
    maximumStart,
    Math.floor((bandStart + bandEnd) / 2) - half,
  ));
  const candidates: number[] = [];
  const maximumDistance = Math.max(
    target - minimumStart,
    maximumStart - target,
  );
  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    for (const startLba of distance === 0
      ? [target]
      : [target - distance, target + distance]) {
      if (
        startLba < minimumStart ||
        startLba > maximumStart ||
        overlapsUnrecoveredSource(
          startLba,
          DVD_SOURCE_SAMPLE_SECTOR_COUNT,
          unrecoveredSourceRanges,
        )
      ) continue;
      candidates.push(startLba);
    }
  }
  return candidates;
}

export function validateDvdDiscVerificationFindings(
  manifest: DvdSourceSampleManifest | null,
  findings: readonly DvdDiscVerificationSampleFinding[],
): void {
  if (manifest === null) {
    if (findings.length !== 0) {
      throw new DomainInvariantError(
        "DVD disc verification findings require a source manifest",
      );
    }
    return;
  }
  if (findings.length > manifest.samples.length) {
    throw new DomainInvariantError("DVD disc verification findings are invalid");
  }
  for (const [index, finding] of findings.entries()) {
    const reference = manifest.samples[index];
    if (
      reference === undefined ||
      finding.bandIndex !== reference.bandIndex ||
      finding.startLba !== reference.startLba ||
      finding.sectorCount !== reference.sectorCount ||
      finding.referenceDigest !== reference.digest
    ) {
      throw new DomainInvariantError(
        "DVD disc verification finding does not match its source reference",
      );
    }
    if (finding.outcome === "unreadable") {
      const diagnostic = finding.diagnostic;
      if (
        finding.observedDigest !== null ||
        diagnostic === null
      ) {
        throw new DomainInvariantError(
          "DVD disc verification unreadable finding is invalid",
        );
      }
      normalizeDvdDiscVerificationDiagnostic(diagnostic, finding);
      continue;
    }
    requireDigest(
      finding.observedDigest,
      "DVD disc verification observed sample digest",
    );
    if (
      finding.diagnostic !== null ||
      (finding.observedDigest === finding.referenceDigest) !==
        (finding.outcome === "match")
    ) {
      throw new DomainInvariantError(
        "DVD disc verification readable finding is invalid",
      );
    }
  }
}

export function dvdDiscVerificationOutcome(input: {
  metadataMatches: boolean;
  manifestUnavailable: boolean;
  coverageComplete: boolean;
  budgetExhausted: boolean;
  interrupted: boolean;
  insertionChanged: boolean;
  checkpointChanged: boolean;
  findings: readonly DvdDiscVerificationSampleFinding[];
}): {
  outcome: DvdDiscVerificationOutcome;
  reasons: DvdDiscVerificationReasonCode[];
} {
  const reasons: DvdDiscVerificationReasonCode[] = [];
  if (!input.metadataMatches) reasons.push("DISC_METADATA_MISMATCH");
  if (input.findings.some((finding) => finding.outcome === "mismatch")) {
    reasons.push("DISC_SAMPLE_MISMATCH");
  }
  if (input.manifestUnavailable) {
    reasons.push("DISC_SAMPLE_MANIFEST_UNAVAILABLE");
  } else if (!input.coverageComplete) {
    reasons.push("DISC_SAMPLE_COVERAGE_INCOMPLETE");
  }
  if (input.findings.some((finding) => finding.outcome === "unreadable")) {
    reasons.push("DISC_SAMPLE_UNREADABLE");
  }
  if (input.budgetExhausted) reasons.push("DISC_VERIFICATION_TIMEOUT");
  if (input.interrupted) reasons.push("DISC_VERIFICATION_INTERRUPTED");
  if (input.insertionChanged) reasons.push("DISC_INSERTION_CHANGED");
  if (input.checkpointChanged) reasons.push("DISC_CHECKPOINT_CHANGED");
  if (
    reasons.includes("DISC_METADATA_MISMATCH") ||
    reasons.includes("DISC_SAMPLE_MISMATCH")
  ) return { outcome: "mismatch", reasons };
  return reasons.length === 0
    ? { outcome: "match", reasons }
    : { outcome: "inconclusive", reasons };
}
