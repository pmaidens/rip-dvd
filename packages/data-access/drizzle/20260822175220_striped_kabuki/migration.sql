ALTER TABLE `archive_jobs` ADD `failure_detail_version` text;--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `read_failure_stage` text;--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `read_failure_category` text;--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `read_failure_classifier_version` text;--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `read_failure_lba` integer;--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `read_failure_requested_block_count` integer;--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `read_failure_retry_count` integer;--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `read_failure_scsi_status` integer;--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `read_failure_host_status` integer;--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `read_failure_driver_status` integer;--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `read_failure_sense_key` integer;--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `read_failure_asc` integer;--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `read_failure_ascq` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_archive_jobs` (
	`id` text PRIMARY KEY,
	`archive_request_id` text NOT NULL,
	`detected_disc_id` text NOT NULL,
	`original_disc_archive_id` text,
	`attempt_ordinal` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`progress_phase` text DEFAULT 'preparing' NOT NULL,
	`progress_percent` integer DEFAULT 0 NOT NULL,
	`progress_bytes` integer DEFAULT 0 NOT NULL,
	`last_progress_at` integer NOT NULL,
	`claimed_by` text,
	`claim_token` text,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`error_message` text,
	`failure_detail_version` text,
	`read_failure_stage` text,
	`read_failure_category` text,
	`read_failure_classifier_version` text,
	`read_failure_lba` integer,
	`read_failure_requested_block_count` integer,
	`read_failure_retry_count` integer,
	`read_failure_scsi_status` integer,
	`read_failure_host_status` integer,
	`read_failure_driver_status` integer,
	`read_failure_sense_key` integer,
	`read_failure_asc` integer,
	`read_failure_ascq` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_archive_jobs_archive_request_id_archive_requests_id_fk` FOREIGN KEY (`archive_request_id`) REFERENCES `archive_requests`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_archive_jobs_detected_disc_id_detected_discs_id_fk` FOREIGN KEY (`detected_disc_id`) REFERENCES `detected_discs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_archive_jobs_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "archive_jobs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "archive_jobs_status_check" CHECK("status" in ('running', 'completed', 'failed', 'aborted')),
	CONSTRAINT "archive_jobs_progress_check" CHECK("progress_percent" between 0 and 100),
	CONSTRAINT "archive_jobs_progress_bytes_check" CHECK(typeof("progress_bytes") = 'integer' and "progress_bytes" >= 0),
	CONSTRAINT "archive_jobs_progress_phase_check" CHECK("progress_phase" in ('preparing', 'copying', 'verifying', 'finalizing')),
	CONSTRAINT "archive_jobs_attempt_ordinal_check" CHECK(typeof("attempt_ordinal") = 'integer' and "attempt_ordinal" > 0),
	CONSTRAINT "archive_jobs_attempt_shape_check" CHECK(("status" = 'running' and "claimed_by" is not null and "claim_token" is not null and "claimed_at" is not null and "started_at" is not null and "completed_at" is null) or ("status" <> 'running' and "started_at" is not null and "completed_at" is not null)),
	CONSTRAINT "archive_jobs_failure_detail_version_check" CHECK("failure_detail_version" is null or ("status" = 'failed' and "failure_detail_version" in ('archive-failure-detail-v1'))),
	CONSTRAINT "archive_jobs_read_failure_shape_check" CHECK(("read_failure_category" is null and "read_failure_stage" is null and "read_failure_classifier_version" is null and "read_failure_lba" is null and "read_failure_requested_block_count" is null and "read_failure_retry_count" is null and "read_failure_scsi_status" is null and "read_failure_host_status" is null and "read_failure_driver_status" is null and "read_failure_sense_key" is null and "read_failure_asc" is null and "read_failure_ascq" is null) or ("status" = 'failed' and "read_failure_stage" in ('initial_copy', 'rescue_resume') and "read_failure_category" = 'unknown' and typeof("read_failure_classifier_version") = 'text' and length("read_failure_classifier_version") between 1 and 128 and typeof("read_failure_lba") = 'integer' and "read_failure_lba" >= 0 and typeof("read_failure_requested_block_count") = 'integer' and "read_failure_requested_block_count" between 1 and 4294967295 and typeof("read_failure_retry_count") = 'integer' and "read_failure_retry_count" between 0 and 4294967295 and ("read_failure_scsi_status" is null or (typeof("read_failure_scsi_status") = 'integer' and "read_failure_scsi_status" between 0 and 255)) and ("read_failure_host_status" is null or (typeof("read_failure_host_status") = 'integer' and "read_failure_host_status" between 0 and 65535)) and ("read_failure_driver_status" is null or (typeof("read_failure_driver_status") = 'integer' and "read_failure_driver_status" between 0 and 65535)) and ("read_failure_sense_key" is null or (typeof("read_failure_sense_key") = 'integer' and "read_failure_sense_key" between 0 and 15)) and ("read_failure_asc" is null or (typeof("read_failure_asc") = 'integer' and "read_failure_asc" between 0 and 255)) and ("read_failure_ascq" is null or (typeof("read_failure_ascq") = 'integer' and "read_failure_ascq" between 0 and 255)) and (("read_failure_scsi_status" is null and "read_failure_host_status" is null and "read_failure_driver_status" is null) or ("read_failure_scsi_status" is not null and "read_failure_host_status" is not null and "read_failure_driver_status" is not null)) and (("read_failure_asc" is null and "read_failure_ascq" is null) or ("read_failure_asc" is not null and "read_failure_ascq" is not null))))
);
--> statement-breakpoint
INSERT INTO `__new_archive_jobs`(`id`, `archive_request_id`, `detected_disc_id`, `original_disc_archive_id`, `attempt_ordinal`, `status`, `priority`, `progress_phase`, `progress_percent`, `progress_bytes`, `last_progress_at`, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `created_at`, `updated_at`) SELECT `id`, `archive_request_id`, `detected_disc_id`, `original_disc_archive_id`, `attempt_ordinal`, `status`, `priority`, `progress_phase`, `progress_percent`, `progress_bytes`, `last_progress_at`, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `created_at`, `updated_at` FROM `archive_jobs`;--> statement-breakpoint
DROP TABLE `archive_jobs`;--> statement-breakpoint
ALTER TABLE `__new_archive_jobs` RENAME TO `archive_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `archive_jobs_request_attempt_unique` ON `archive_jobs` (`archive_request_id`,`attempt_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `archive_jobs_running_request_unique` ON `archive_jobs` (`archive_request_id`) WHERE "archive_jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `archive_jobs_request_idx` ON `archive_jobs` (`archive_request_id`,`attempt_ordinal`);