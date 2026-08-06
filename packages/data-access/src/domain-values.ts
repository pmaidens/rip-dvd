export const DISC_KINDS = ["dvd", "blu_ray", "audio_cd"] as const;

export const ARCHIVE_FORMATS = ["iso"] as const;

export const DETECTED_DISC_STATUSES = [
  "detected",
  "scanned",
  "approved",
  "archived",
  "rejected",
] as const;

export const MEDIA_ITEM_KINDS = [
  "movie",
  "tv_show",
  "season",
  "episode",
  "trailer",
  "bonus_feature",
  "other",
] as const;

export const MAX_MEDIA_ITEM_HIERARCHY_DEPTH = 32;

export const DISC_SELECTION_KINDS = [
  "main_feature",
  "dvd_title",
  "dvd_chapters",
] as const;

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
