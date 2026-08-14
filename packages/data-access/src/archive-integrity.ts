import { DomainInvariantError } from "./errors.js";
import type {
  CleanReadArchiveIntegrityEvidence,
  UnknownArchiveIntegrityEvidence,
} from "./types.js";

export function createCleanReadArchiveIntegrityEvidence(
  policyVersion: string,
): CleanReadArchiveIntegrityEvidence {
  const normalizedPolicyVersion = policyVersion.trim();
  if (
    normalizedPolicyVersion.length === 0 ||
    normalizedPolicyVersion.length > 128
  ) {
    throw new DomainInvariantError(
      "Archive Integrity policy version must contain 1 to 128 characters",
    );
  }
  return {
    integrity: "clean_read",
    policyVersion: normalizedPolicyVersion,
    badSectorCount: 0,
    badAreaCount: 0,
    badSectorRanges: [],
  };
}

export function createUnknownArchiveIntegrityEvidence(): UnknownArchiveIntegrityEvidence {
  return {
    integrity: "unknown",
    policyVersion: null,
    badSectorCount: null,
    badAreaCount: null,
    badSectorRanges: null,
  };
}
