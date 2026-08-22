export {
  DISC_SELECTION_KINDS,
  MEDIA_ITEM_KINDS,
} from "./catalog-kinds.js";

export const DISC_KINDS = ["dvd", "blu_ray", "audio_cd"] as const;

export const ARCHIVE_FORMATS = ["iso"] as const;

export const ARCHIVE_INTEGRITIES = [
  "unknown",
  "clean_read",
  "watchable_salvage",
] as const;

export const DVD_SALVAGE_REJECTION_DESCRIPTIONS = {
  filesystem_metadata: "filesystem metadata",
  directory_data: "filesystem directory data",
  ifo: "DVD IFO data",
  bup: "DVD backup data",
  menu: "DVD menu data",
  navigation: "DVD navigation data",
  referenced_content: "referenced DVD content",
  ambiguous: "an ambiguous DVD region",
  unmappable: "an unmappable DVD region",
  consecutive_damage: "consecutive unreadable sectors",
  policy_limit: "damage beyond the automatic salvage policy limit",
  decoder_stream: "a missing decoded audio or video stream",
  decoder_duration: "an incomplete decoded title duration",
  decoder_rate: "decoding failures beyond the automatic salvage policy limit",
  decoder_incomplete: "incomplete DVD title traversal",
} as const;

export type DvdSalvageRejectionReason =
  keyof typeof DVD_SALVAGE_REJECTION_DESCRIPTIONS;

export const CATALOG_REVIEW_OUTCOMES = [
  "needs_review",
  "reviewed_with_selections",
  "archive_only",
] as const;

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

export const TMDB_MEDIA_TYPES = ["movie", "tv_show"] as const;

export const ENCODE_JOB_STATUSES = [
  "queued",
  "running",
  "cancellation_requested",
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

export const ARCHIVE_READ_FAILURE_STAGES = [
  "initial_copy",
  "rescue_resume",
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
  "settling",
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

export const RETAINED_ENCODE_OUTPUT_STATES = ["retained"] as const;

export const FILESYSTEM_VERIFICATION_STATUSES = [
  "accessible",
  "missing",
  "inaccessible",
  "error",
] as const;
