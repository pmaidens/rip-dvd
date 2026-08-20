ALTER TABLE `archive_jobs` ADD `progress_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `last_progress_at` integer;--> statement-breakpoint
UPDATE `archive_jobs` SET `last_progress_at` = `updated_at`;--> statement-breakpoint
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
	CONSTRAINT "archive_jobs_attempt_shape_check" CHECK(("status" = 'running' and "claimed_by" is not null and "claim_token" is not null and "claimed_at" is not null and "started_at" is not null and "completed_at" is null) or ("status" <> 'running' and "started_at" is not null and "completed_at" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_archive_jobs`(`id`, `archive_request_id`, `detected_disc_id`, `original_disc_archive_id`, `attempt_ordinal`, `status`, `priority`, `progress_phase`, `progress_percent`, `progress_bytes`, `last_progress_at`, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `created_at`, `updated_at`) SELECT `id`, `archive_request_id`, `detected_disc_id`, `original_disc_archive_id`, `attempt_ordinal`, `status`, `priority`, `progress_phase`, `progress_percent`, `progress_bytes`, `last_progress_at`, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `created_at`, `updated_at` FROM `archive_jobs`;--> statement-breakpoint
DROP TABLE `archive_jobs`;--> statement-breakpoint
ALTER TABLE `__new_archive_jobs` RENAME TO `archive_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `archive_jobs_request_attempt_unique` ON `archive_jobs` (`archive_request_id`,`attempt_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `archive_jobs_running_request_unique` ON `archive_jobs` (`archive_request_id`) WHERE "archive_jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `archive_jobs_request_idx` ON `archive_jobs` (`archive_request_id`,`attempt_ordinal`);
