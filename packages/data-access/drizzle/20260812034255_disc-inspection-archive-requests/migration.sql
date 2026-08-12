CREATE TABLE `archive_requests` (
	`id` text PRIMARY KEY,
	`detected_disc_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`cancellation_requested_at` integer,
	`fulfilled_at` integer,
	`cancelled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_archive_requests_detected_disc_id_detected_discs_id_fk` FOREIGN KEY (`detected_disc_id`) REFERENCES `detected_discs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "archive_requests_id_not_null" CHECK("id" is not null),
	CONSTRAINT "archive_requests_status_check" CHECK("status" in ('pending', 'running', 'needs_attention', 'cancellation_requested', 'fulfilled', 'cancelled')),
	CONSTRAINT "archive_requests_terminal_fields_check" CHECK(("fulfilled_at" is not null) = ("status" = 'fulfilled') and ("cancelled_at" is not null) = ("status" = 'cancelled') and ("cancellation_requested_at" is not null) = ("status" in ('cancellation_requested', 'cancelled')))
);;
--> statement-breakpoint
CREATE TABLE `disc_inspections` (
	`id` text PRIMARY KEY,
	`optical_drive_id` text NOT NULL,
	`detected_disc_id` text,
	`media_generation` text NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`phase` text DEFAULT 'reading_metadata' NOT NULL,
	`attempt_count` integer DEFAULT 1 NOT NULL,
	`consecutive_failure_count` integer DEFAULT 0 NOT NULL,
	`volume_label` text,
	`title_count` integer,
	`chapter_count` integer,
	`audio_stream_count` integer,
	`subtitle_stream_count` integer,
	`total_bytes` integer,
	`bytes_hashed` integer,
	`bytes_per_second` integer,
	`eta_seconds` integer,
	`retry_at` integer,
	`reason_code` text,
	`diagnostic` text,
	`claim_token` text,
	`claim_updated_at` integer,
	`phase_started_at` integer NOT NULL,
	`attempt_started_at` integer NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_disc_inspections_optical_drive_id_optical_drives_id_fk` FOREIGN KEY (`optical_drive_id`) REFERENCES `optical_drives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_disc_inspections_detected_disc_id_detected_discs_id_fk` FOREIGN KEY (`detected_disc_id`) REFERENCES `detected_discs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "disc_inspections_id_not_null" CHECK("id" is not null),
	CONSTRAINT "disc_inspections_status_check" CHECK("status" in ('running', 'completed', 'failed', 'aborted')),
	CONSTRAINT "disc_inspections_phase_check" CHECK("phase" in ('reading_metadata', 'hashing_content', 'confirming_media', 'retry_wait')),
	CONSTRAINT "disc_inspections_reason_check" CHECK("reason_code" is null or "reason_code" in ('no_medium', 'media_changed', 'drive_identity_changed', 'drive_unavailable', 'drive_not_ready', 'metadata_read_failed', 'invalid_metadata', 'content_size_failed', 'content_read_failed', 'invalid_content', 'worker_interrupted', 'operator_cancelled', 'unknown')),
	CONSTRAINT "disc_inspections_generation_check" CHECK(length("media_generation") between 1 and 64),
	CONSTRAINT "disc_inspections_attempt_count_check" CHECK(typeof("attempt_count") = 'integer' and "attempt_count" > 0 and typeof("consecutive_failure_count") = 'integer' and "consecutive_failure_count" between 0 and 5 and "consecutive_failure_count" <= "attempt_count"),
	CONSTRAINT "disc_inspections_findings_check" CHECK(("title_count" is null or (typeof("title_count") = 'integer' and "title_count" >= 0)) and ("chapter_count" is null or (typeof("chapter_count") = 'integer' and "chapter_count" >= 0)) and ("audio_stream_count" is null or (typeof("audio_stream_count") = 'integer' and "audio_stream_count" >= 0)) and ("subtitle_stream_count" is null or (typeof("subtitle_stream_count") = 'integer' and "subtitle_stream_count" >= 0))),
	CONSTRAINT "disc_inspections_progress_check" CHECK(("total_bytes" is null or (typeof("total_bytes") = 'integer' and "total_bytes" >= 0)) and ("bytes_hashed" is null or (typeof("bytes_hashed") = 'integer' and "bytes_hashed" >= 0 and ("total_bytes" is null or "bytes_hashed" <= "total_bytes")))),
	CONSTRAINT "disc_inspections_estimate_check" CHECK(("bytes_per_second" is null) = ("eta_seconds" is null) and ("bytes_per_second" is null or (typeof("bytes_per_second") = 'integer' and "bytes_per_second" > 0 and typeof("eta_seconds") = 'integer' and "eta_seconds" >= 0))),
	CONSTRAINT "disc_inspections_claim_check" CHECK(("claim_token" is null) = ("claim_updated_at" is null) and ("claim_token" is null or "status" = 'running')),
	CONSTRAINT "disc_inspections_terminal_check" CHECK(("status" = 'running') = ("completed_at" is null) and ("status" = 'completed') = ("detected_disc_id" is not null)),
	CONSTRAINT "disc_inspections_retry_check" CHECK("retry_at" is null or ("status" = 'running' and "phase" = 'retry_wait'))
);;
--> statement-breakpoint
CREATE TABLE `disc_inspection_attempts` (
	`id` text PRIMARY KEY,
	`disc_inspection_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`outcome` text NOT NULL,
	`phase` text NOT NULL,
	`reason_code` text,
	`diagnostic` text,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	CONSTRAINT `fk_disc_inspection_attempts_disc_inspection_id_disc_inspections_id_fk` FOREIGN KEY (`disc_inspection_id`) REFERENCES `disc_inspections`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "disc_inspection_attempts_id_not_null" CHECK("id" is not null),
	CONSTRAINT "disc_inspection_attempts_number_check" CHECK(typeof("attempt_number") = 'integer' and "attempt_number" > 0),
	CONSTRAINT "disc_inspection_attempts_outcome_check" CHECK("outcome" in ('completed', 'failed', 'aborted', 'interrupted')),
	CONSTRAINT "disc_inspection_attempts_phase_check" CHECK("phase" in ('reading_metadata', 'hashing_content', 'confirming_media', 'retry_wait')),
	CONSTRAINT "disc_inspection_attempts_reason_check" CHECK("reason_code" is null or "reason_code" in ('no_medium', 'media_changed', 'drive_identity_changed', 'drive_unavailable', 'drive_not_ready', 'metadata_read_failed', 'invalid_metadata', 'content_size_failed', 'content_read_failed', 'invalid_content', 'worker_interrupted', 'operator_cancelled', 'unknown'))
);;
--> statement-breakpoint
INSERT INTO `archive_requests` (
  `id`, `detected_disc_id`, `status`, `priority`,
  `cancellation_requested_at`, `fulfilled_at`, `cancelled_at`,
  `created_at`, `updated_at`
)
SELECT
  'archive-request:' || `id`,
  `detected_disc_id`,
  CASE `status`
    WHEN 'queued' THEN 'pending'
    WHEN 'running' THEN 'running'
    WHEN 'completed' THEN 'fulfilled'
    WHEN 'failed' THEN 'needs_attention'
  END,
  `priority`,
  NULL,
  CASE WHEN `status` = 'completed'
    THEN coalesce(`completed_at`, `updated_at`) ELSE NULL END,
  NULL,
  `created_at`,
  `updated_at`
FROM `archive_jobs`;
--> statement-breakpoint
INSERT INTO `archive_requests` (
  `id`, `detected_disc_id`, `status`, `priority`,
  `created_at`, `updated_at`
)
SELECT
  'archive-request:disc:' || `detected_discs`.`id`,
  `detected_discs`.`id`,
  'pending',
  0,
  `detected_discs`.`updated_at`,
  `detected_discs`.`updated_at`
FROM `detected_discs`
WHERE `detected_discs`.`status` = 'approved'
  AND NOT EXISTS (
    SELECT 1
    FROM `archive_requests`
    WHERE `archive_requests`.`detected_disc_id` = `detected_discs`.`id`
  );
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `archive_jobs_next` (
	`id` text PRIMARY KEY,
	`archive_request_id` text NOT NULL,
	`detected_disc_id` text NOT NULL,
	`original_disc_archive_id` text,
	`attempt_ordinal` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`progress_phase` text DEFAULT 'preparing' NOT NULL,
	`progress_percent` integer DEFAULT 0 NOT NULL,
	`claimed_by` text,
	`claim_token` text,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_archive_jobs_archive_request_id_archive_requests_id_fk` FOREIGN KEY (`archive_request_id`) REFERENCES `archive_requests`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_archive_jobs_detected_disc_id_detected_discs_id_fk` FOREIGN KEY (`detected_disc_id`) REFERENCES `detected_discs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_archive_jobs_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "archive_jobs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "archive_jobs_status_check" CHECK("status" in ('running', 'completed', 'failed', 'aborted')),
	CONSTRAINT "archive_jobs_progress_check" CHECK("progress_percent" between 0 and 100),
	CONSTRAINT "archive_jobs_progress_phase_check" CHECK("progress_phase" in ('preparing', 'copying', 'verifying', 'finalizing')),
	CONSTRAINT "archive_jobs_attempt_ordinal_check" CHECK(typeof("attempt_ordinal") = 'integer' and "attempt_ordinal" > 0),
	CONSTRAINT "archive_jobs_attempt_shape_check" CHECK(("status" = 'running' and "claimed_by" is not null and "claim_token" is not null and "claimed_at" is not null and "started_at" is not null and "completed_at" is null) or ("status" <> 'running' and "started_at" is not null and "completed_at" is not null))
);;
--> statement-breakpoint
INSERT INTO `archive_jobs_next` (
  `id`, `archive_request_id`, `detected_disc_id`,
  `original_disc_archive_id`, `attempt_ordinal`, `status`, `priority`,
  `progress_phase`, `progress_percent`, `claimed_by`, `claim_token`,
  `claimed_at`, `started_at`, `completed_at`, `error_message`,
  `created_at`, `updated_at`
)
SELECT
  `id`,
  'archive-request:' || `id`,
  `detected_disc_id`,
  `original_disc_archive_id`,
  1,
  `status`,
  `priority`,
  CASE
    WHEN `progress_phase` IN ('preparing', 'copying', 'verifying', 'finalizing')
      THEN `progress_phase`
    WHEN `status` = 'completed' THEN 'finalizing'
    ELSE 'preparing'
  END,
  `progress_percent`,
  CASE WHEN `status` = 'running'
    THEN coalesce(`claimed_by`, 'legacy-migrated-worker')
    ELSE `claimed_by` END,
  CASE WHEN `status` = 'running'
    THEN coalesce(`claim_token`, 'legacy-claim:' || `id`)
    ELSE `claim_token` END,
  CASE WHEN `status` = 'running'
    THEN coalesce(`claimed_at`, `started_at`, `updated_at`)
    ELSE `claimed_at` END,
  coalesce(`started_at`, `created_at`),
  CASE WHEN `status` = 'running'
    THEN NULL
    ELSE coalesce(`completed_at`, `updated_at`) END,
  `error_message`,
  `created_at`,
  `updated_at`
FROM `archive_jobs`
WHERE `status` <> 'queued';
--> statement-breakpoint
DROP TABLE `archive_jobs`;
--> statement-breakpoint
ALTER TABLE `archive_jobs_next` RENAME TO `archive_jobs`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE UNIQUE INDEX `archive_jobs_request_attempt_unique` ON `archive_jobs` (`archive_request_id`,`attempt_ordinal`);;
--> statement-breakpoint
CREATE UNIQUE INDEX `archive_jobs_running_request_unique` ON `archive_jobs` (`archive_request_id`) WHERE "archive_jobs"."status" = 'running';;
--> statement-breakpoint
CREATE INDEX `archive_jobs_request_idx` ON `archive_jobs` (`archive_request_id`,`attempt_ordinal`);;
--> statement-breakpoint
CREATE UNIQUE INDEX `archive_requests_nonterminal_disc_unique` ON `archive_requests` (`detected_disc_id`) WHERE "archive_requests"."status" in ('pending', 'running', 'needs_attention', 'cancellation_requested');;
--> statement-breakpoint
CREATE INDEX `archive_requests_status_idx` ON `archive_requests` (`status`,`priority`,`created_at`);;
--> statement-breakpoint
CREATE UNIQUE INDEX `disc_inspection_attempts_number_unique` ON `disc_inspection_attempts` (`disc_inspection_id`,`attempt_number`);;
--> statement-breakpoint
CREATE UNIQUE INDEX `disc_inspections_current_drive_unique` ON `disc_inspections` (`optical_drive_id`) WHERE "disc_inspections"."is_current" = 1;;
--> statement-breakpoint
CREATE INDEX `disc_inspections_status_idx` ON `disc_inspections` (`status`,`updated_at`);;
--> statement-breakpoint
PRAGMA foreign_key_check;
