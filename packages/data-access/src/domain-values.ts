export {
  DISC_SELECTION_KINDS,
  MEDIA_ITEM_KINDS,
} from "./catalog-kinds.js";

export const DISC_KINDS = ["dvd", "blu_ray", "audio_cd"] as const;

export const ARCHIVE_FORMATS = ["iso"] as const;

export const DETECTED_DISC_STATUSES = [
  "detected",
  "scanned",
  "approved",
  "archived",
  "rejected",
] as const;

/**
 * Maximum levels in a Media Item parent-child chain, including the root.
 * This does not limit siblings or the total number of Media Items.
 */
export const MAX_MEDIA_ITEM_HIERARCHY_DEPTH = 32;

export const MEDIA_DOMAINS = ["dvd_video", "audio"] as const;

export const ENCODE_JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export const ARCHIVE_JOB_STATUSES = [
  "running",
  "completed",
  "failed",
  "aborted",
] as const;

export const ARCHIVE_REQUEST_STATUSES = [
  "pending",
  "running",
  "needs_attention",
  "cancellation_requested",
  "fulfilled",
  "cancelled",
] as const;

export const DISC_INSPECTION_STATUSES = [
  "running",
  "completed",
  "failed",
  "aborted",
] as const;

export const DISC_INSPECTION_PHASES = [
  "reading_metadata",
  "hashing_content",
  "confirming_media",
  "retry_wait",
] as const;

export const DISC_INSPECTION_ATTEMPT_OUTCOMES = [
  "completed",
  "failed",
  "aborted",
  "interrupted",
] as const;

export const DISC_INSPECTION_REASON_CODES = [
  "no_medium",
  "media_changed",
  "drive_identity_changed",
  "drive_unavailable",
  "drive_not_ready",
  "metadata_read_failed",
  "invalid_metadata",
  "content_size_failed",
  "content_read_failed",
  "invalid_content",
  "worker_interrupted",
  "operator_cancelled",
  "unknown",
] as const;

export const ARCHIVE_RUNNING_PROGRESS_PHASES = [
  "preparing",
  "copying",
  "verifying",
  "finalizing",
] as const;

export const ENCODE_PROGRESS_PHASES = [
  "scanning",
  "previewing",
  "encoding",
] as const;

export const FILESYSTEM_VERIFICATION_STATUSES = [
  "accessible",
  "missing",
  "inaccessible",
  "error",
] as const;
