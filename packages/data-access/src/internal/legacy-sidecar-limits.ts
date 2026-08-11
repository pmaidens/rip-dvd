export const MAX_LEGACY_SIDECAR_BYTES = 1_048_576;
export const MAX_LEGACY_SIDECAR_JOBS = 100;
export const MAX_LEGACY_MARKER_BYTES = 8_388_608;
export const MAX_LEGACY_LIBRARY_DEPTH = 32;
export const MAX_LEGACY_LIBRARY_ENTRIES = 10_000;

export const LEGACY_MARKER_PREFIX =
  '{"schemaVersion":4,"legacyQueueStatus":"retired","authoritativeStore":"sqlite","legacySidecars":';

export const LEGACY_MARKER_FIXED_BYTES = Buffer.byteLength(
  `${LEGACY_MARKER_PREFIX}[],"legacyJobs":[],"snapshotDigest":"${"0".repeat(64)}"}\n`,
  "utf8",
);
