import { createHash } from "node:crypto";

import {
  type ArchiveBoundaryEvidence,
  validateDvdArchiveBoundaryEvidence,
} from "./archive-boundary.js";
import { DomainInvariantError } from "./errors.js";
import type {
  DvdArchiveEvidenceFormat,
  DvdUnrecoveredSourceRange,
} from "./types.js";

const BOUNDARY_EVIDENCE_DOMAIN =
  "rip-dvd:dvd-archive-boundary-evidence:v1\0";
const SOURCE_RANGES_DOMAIN =
  "rip-dvd:dvd-unrecovered-source-ranges:v1\0";
const RECOVERY_READ_EVIDENCE_DOMAIN =
  "rip-dvd:dvd-archive-recovery-read-evidence:v1\0";
const EVIDENCE_MANIFEST_DOMAIN =
  "rip-dvd:dvd-archive-evidence-manifest:v1\0";

type DvdArchiveRecoveryReadOutcome = "recovered" | "failed";

export interface DvdArchiveRecoveryReadEvidenceDigestInput {
  originalDiscArchiveId: string;
  fromManifestId: string;
  fromManifestRevision: number;
  startLba: number;
  sectorCount: number;
  outcome: DvdArchiveRecoveryReadOutcome;
}

export interface DvdArchiveEvidenceManifestDigestInput {
  originalDiscArchiveId: string;
  revision: number;
  previousManifestId: string | null;
  previousManifestDigest: string | null;
  recoveryReadId: string | null;
  recoveryReadEvidenceDigest: string | null;
  evidenceFormat: DvdArchiveEvidenceFormat;
  imageFingerprint: string;
  sectorSizeBytes: number;
  acceptedEndLbaExclusive: number;
  boundaryPolicyVersion: string;
  boundaryReportedSizeBytes: number;
  boundaryPublishedSizeBytes: number;
  boundaryEvidenceDigest: string;
  unrecoveredSourceRanges: readonly DvdUnrecoveredSourceRange[];
}

export interface DvdArchiveEvidenceManifestDigests {
  unrecoveredSourceRangesDigest: string;
  manifestDigest: string;
}

function digest(domain: string, payload: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update(JSON.stringify(payload))
    .digest("hex");
}

function requireNonEmptyString(value: string, description: string): void {
  if (value.length === 0) {
    throw new DomainInvariantError(`${description} must not be empty`);
  }
}

function requireSafeInteger(
  value: number,
  description: string,
  minimum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new DomainInvariantError(
      `${description} must be a safe integer of at least ${minimum}`,
    );
  }
}

function requireSha256Digest(value: string, description: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new DomainInvariantError(
      `${description} must be a lowercase SHA-256 digest`,
    );
  }
}

function canonicalBoundaryPayload(evidence: ArchiveBoundaryEvidence): unknown {
  if (evidence.excludedSectorCount === 0) {
    if (evidence.policyVersion === "dvd-archive-boundary-v1") {
      return [
        evidence.policyVersion,
        evidence.reportedSizeBytes,
        evidence.publishedSizeBytes,
        evidence.excludedSectorCount,
        null,
      ];
    }
    return [
      evidence.policyVersion,
      evidence.reportedSizeBytes,
      evidence.publishedSizeBytes,
      evidence.excludedSectorCount,
      [
        evidence.endpointProof.proofVersion,
        evidence.endpointProof.confirmationCount,
        evidence.endpointProof.firstExcludedLba,
        [
          evidence.endpointProof.outOfRangeEvidence.classifierVersion,
          evidence.endpointProof.outOfRangeEvidence.scsiStatus,
          evidence.endpointProof.outOfRangeEvidence.hostStatus,
          evidence.endpointProof.outOfRangeEvidence.driverStatus,
          evidence.endpointProof.outOfRangeEvidence.senseResponseCode,
          evidence.endpointProof.outOfRangeEvidence.senseKey,
          evidence.endpointProof.outOfRangeEvidence.asc,
          evidence.endpointProof.outOfRangeEvidence.ascq,
        ],
      ],
    ];
  }
  if (!("firstExcludedLba" in evidence)) {
    throw new DomainInvariantError("Archive Boundary Evidence is invalid");
  }
  return [
    evidence.policyVersion,
    evidence.reportedSizeBytes,
    evidence.publishedSizeBytes,
    evidence.excludedSectorCount,
    evidence.firstExcludedLba,
    evidence.maximumReferencedLba,
    [
      evidence.outOfRangeEvidence.classifierVersion,
      evidence.outOfRangeEvidence.scsiStatus,
      evidence.outOfRangeEvidence.hostStatus,
      evidence.outOfRangeEvidence.driverStatus,
      evidence.outOfRangeEvidence.senseResponseCode,
      evidence.outOfRangeEvidence.senseKey,
      evidence.outOfRangeEvidence.asc,
      evidence.outOfRangeEvidence.ascq,
    ],
  ];
}

/**
 * Hashes the complete normalized Archive Boundary Evidence record. The domain
 * prefix and positional JSON payload are the canonical v1 byte encoding.
 */
export function createDvdArchiveBoundaryEvidenceDigest(
  evidence: ArchiveBoundaryEvidence,
): string {
  const normalized = validateDvdArchiveBoundaryEvidence(
    evidence,
    evidence.publishedSizeBytes,
  );
  return digest(BOUNDARY_EVIDENCE_DOMAIN, canonicalBoundaryPayload(normalized));
}

export function assertDvdArchiveBoundaryEvidenceDigest(
  evidence: ArchiveBoundaryEvidence,
  evidenceDigest: string,
): void {
  if (createDvdArchiveBoundaryEvidenceDigest(evidence) !== evidenceDigest) {
    throw new DomainInvariantError(
      "Persisted DVD Archive Boundary Evidence digest does not match its contents",
    );
  }
}

function canonicalSourceRangesPayload(
  ranges: readonly DvdUnrecoveredSourceRange[],
): readonly (readonly [number, number, DvdUnrecoveredSourceRange["classification"]])[] {
  let previous: DvdUnrecoveredSourceRange | undefined;
  const canonical = ranges.map((range) => {
    requireSafeInteger(range.startLba, "Unrecovered Source start LBA", 0);
    requireSafeInteger(range.sectorCount, "Unrecovered Source sector count", 1);
    if (
      range.classification !== "skipped_untested" &&
      range.classification !== "individually_failed"
    ) {
      throw new DomainInvariantError(
        "Unrecovered Source classification is invalid",
      );
    }
    const endLbaExclusive = range.startLba + range.sectorCount;
    if (!Number.isSafeInteger(endLbaExclusive)) {
      throw new DomainInvariantError(
        "Unrecovered Source range exceeds the safe integer limit",
      );
    }
    if (previous !== undefined) {
      const previousEndLbaExclusive =
        previous.startLba + previous.sectorCount;
      if (
        range.startLba < previousEndLbaExclusive ||
        (range.startLba === previousEndLbaExclusive &&
          range.classification === previous.classification)
      ) {
        throw new DomainInvariantError(
          "Unrecovered Source ranges must be canonically normalized",
        );
      }
    }
    previous = range;
    return [
      range.startLba,
      range.sectorCount,
      range.classification,
    ] as const;
  });
  return canonical;
}

/**
 * Hashes the ordered, normalized range tuples. Callers must not sort or merge
 * ranges while hashing because a noncanonical map is rejected.
 */
export function createDvdUnrecoveredSourceRangesDigest(
  ranges: readonly DvdUnrecoveredSourceRange[],
): string {
  return digest(SOURCE_RANGES_DOMAIN, canonicalSourceRangesPayload(ranges));
}

export function assertDvdUnrecoveredSourceRangesDigest(
  ranges: readonly DvdUnrecoveredSourceRange[],
  rangesDigest: string,
): void {
  if (createDvdUnrecoveredSourceRangesDigest(ranges) !== rangesDigest) {
    throw new DomainInvariantError(
      "Persisted Unrecovered Source ranges digest does not match its contents",
    );
  }
}

/** Hashes the complete persisted one-sector recovery observation. */
export function createDvdArchiveRecoveryReadEvidenceDigest(
  input: DvdArchiveRecoveryReadEvidenceDigestInput,
): string {
  requireNonEmptyString(
    input.originalDiscArchiveId,
    "Recovery read Original Disc Archive ID",
  );
  requireNonEmptyString(input.fromManifestId, "Recovery read manifest ID");
  requireSafeInteger(
    input.fromManifestRevision,
    "Recovery read manifest revision",
    1,
  );
  requireSafeInteger(input.startLba, "Recovery read start LBA", 0);
  if (input.sectorCount !== 1) {
    throw new DomainInvariantError(
      "DVD Archive Recovery evidence must describe one sector",
    );
  }
  if (input.outcome !== "recovered" && input.outcome !== "failed") {
    throw new DomainInvariantError("Recovery read outcome is invalid");
  }
  return digest(RECOVERY_READ_EVIDENCE_DOMAIN, [
    input.originalDiscArchiveId,
    input.fromManifestId,
    input.fromManifestRevision,
    input.startLba,
    input.sectorCount,
    input.outcome,
  ]);
}

export function assertDvdArchiveRecoveryReadEvidenceDigest(
  input: DvdArchiveRecoveryReadEvidenceDigestInput,
  evidenceDigest: string,
): void {
  if (
    createDvdArchiveRecoveryReadEvidenceDigest(input) !== evidenceDigest
  ) {
    throw new DomainInvariantError(
      "Persisted DVD Archive Recovery evidence digest does not match its contents",
    );
  }
}

/**
 * Computes both content digests before a manifest is persisted. A later
 * manifest binds the exact predecessor and recovery-read digests, so the
 * current digest commits to the complete revision chain.
 */
export function createDvdArchiveEvidenceManifestDigests(
  input: DvdArchiveEvidenceManifestDigestInput,
): DvdArchiveEvidenceManifestDigests {
  requireNonEmptyString(
    input.originalDiscArchiveId,
    "Evidence manifest Original Disc Archive ID",
  );
  requireSafeInteger(input.revision, "Evidence manifest revision", 1);
  requireNonEmptyString(input.imageFingerprint, "Evidence image fingerprint");
  if (input.evidenceFormat !== "dvd-recovery-evidence-v1") {
    throw new DomainInvariantError("DVD Archive Evidence format is invalid");
  }
  if (input.imageFingerprint.length > 512) {
    throw new DomainInvariantError("Evidence image fingerprint is too long");
  }
  if (input.sectorSizeBytes !== 2_048) {
    throw new DomainInvariantError("DVD Archive Evidence sector size is invalid");
  }
  requireSafeInteger(
    input.acceptedEndLbaExclusive,
    "Evidence accepted end LBA",
    1,
  );
  requireNonEmptyString(
    input.boundaryPolicyVersion,
    "Evidence boundary policy version",
  );
  if (input.boundaryPolicyVersion.length > 128) {
    throw new DomainInvariantError("Evidence boundary policy version is too long");
  }
  requireSafeInteger(
    input.boundaryReportedSizeBytes,
    "Evidence reported boundary size",
    1,
  );
  requireSafeInteger(
    input.boundaryPublishedSizeBytes,
    "Evidence published boundary size",
    1,
  );
  requireSha256Digest(
    input.boundaryEvidenceDigest,
    "Archive Boundary Evidence digest",
  );
  if (
    input.boundaryPublishedSizeBytes !==
      input.acceptedEndLbaExclusive * input.sectorSizeBytes ||
    input.boundaryPublishedSizeBytes > input.boundaryReportedSizeBytes
  ) {
    throw new DomainInvariantError(
      "DVD Archive Evidence accepted extent is inconsistent",
    );
  }
  for (const range of input.unrecoveredSourceRanges) {
    if (range.startLba + range.sectorCount > input.acceptedEndLbaExclusive) {
      throw new DomainInvariantError(
        "Unrecovered Source range exceeds the accepted extent",
      );
    }
    if (
      input.revision === 1 &&
      range.classification !== "skipped_untested"
    ) {
      throw new DomainInvariantError(
        "Initial DVD Archive Evidence may contain only skipped source ranges",
      );
    }
  }

  if (input.revision === 1) {
    if (
      input.previousManifestId !== null ||
      input.previousManifestDigest !== null ||
      input.recoveryReadId !== null ||
      input.recoveryReadEvidenceDigest !== null
    ) {
      throw new DomainInvariantError(
        "Initial DVD evidence manifest must not reference a predecessor or recovery read",
      );
    }
  } else {
    if (
      input.previousManifestId === null ||
      input.previousManifestDigest === null ||
      input.recoveryReadId === null ||
      input.recoveryReadEvidenceDigest === null
    ) {
      throw new DomainInvariantError(
        "Later DVD evidence manifest must reference its predecessor and recovery read",
      );
    }
    requireNonEmptyString(
      input.previousManifestId,
      "Previous evidence manifest ID",
    );
    requireSha256Digest(
      input.previousManifestDigest,
      "Previous evidence manifest digest",
    );
    requireNonEmptyString(input.recoveryReadId, "Recovery read ID");
    requireSha256Digest(
      input.recoveryReadEvidenceDigest,
      "Recovery read evidence digest",
    );
  }

  const unrecoveredSourceRangesDigest =
    createDvdUnrecoveredSourceRangesDigest(input.unrecoveredSourceRanges);
  const manifestDigest = digest(EVIDENCE_MANIFEST_DOMAIN, [
    input.originalDiscArchiveId,
    input.revision,
    input.previousManifestId,
    input.previousManifestDigest,
    input.recoveryReadId,
    input.recoveryReadEvidenceDigest,
    input.evidenceFormat,
    input.imageFingerprint,
    input.sectorSizeBytes,
    input.acceptedEndLbaExclusive,
    input.boundaryPolicyVersion,
    input.boundaryReportedSizeBytes,
    input.boundaryPublishedSizeBytes,
    input.boundaryEvidenceDigest,
    unrecoveredSourceRangesDigest,
  ]);
  return { unrecoveredSourceRangesDigest, manifestDigest };
}

export function assertDvdArchiveEvidenceManifestDigests(
  input: DvdArchiveEvidenceManifestDigestInput &
    DvdArchiveEvidenceManifestDigests,
): void {
  const expected = createDvdArchiveEvidenceManifestDigests(input);
  assertDvdUnrecoveredSourceRangesDigest(
    input.unrecoveredSourceRanges,
    input.unrecoveredSourceRangesDigest,
  );
  if (
    input.manifestDigest !== expected.manifestDigest
  ) {
    throw new DomainInvariantError(
      "Persisted DVD Archive Evidence digest does not match its contents",
    );
  }
}
