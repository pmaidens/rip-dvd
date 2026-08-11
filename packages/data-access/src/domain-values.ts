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

export const MAX_MEDIA_ITEM_HIERARCHY_DEPTH = 32;

export const MEDIA_DOMAINS = ["dvd_video", "audio"] as const;

export const JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
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
