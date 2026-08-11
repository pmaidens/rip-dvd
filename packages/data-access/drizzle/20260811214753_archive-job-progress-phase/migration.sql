PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_archive_jobs` (
	`id` text PRIMARY KEY,
	`detected_disc_id` text NOT NULL,
	`original_disc_archive_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`progress_phase` text DEFAULT 'waiting' NOT NULL,
	`progress_percent` integer DEFAULT 0 NOT NULL,
	`inspection_token` text,
	`inspection_updated_at` integer,
	`claimed_by` text,
	`claim_token` text,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_archive_jobs_detected_disc_id_detected_discs_id_fk` FOREIGN KEY (`detected_disc_id`) REFERENCES `detected_discs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_archive_jobs_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "archive_jobs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "archive_jobs_status_check" CHECK("status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "archive_jobs_progress_check" CHECK("progress_percent" between 0 and 100),
	CONSTRAINT "archive_jobs_progress_phase_check" CHECK("progress_phase" in ('waiting', 'inspecting_drive', 'preparing', 'copying', 'verifying', 'finalizing')),
	CONSTRAINT "archive_jobs_status_progress_phase_check" CHECK(("status" = 'queued' and "progress_phase" in ('waiting', 'inspecting_drive')) or ("status" <> 'queued' and "progress_phase" in ('preparing', 'copying', 'verifying', 'finalizing'))),
	CONSTRAINT "archive_jobs_inspection_lease_check" CHECK(("progress_phase" = 'inspecting_drive') = ("inspection_token" is not null and "inspection_updated_at" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_archive_jobs`(`id`, `detected_disc_id`, `original_disc_archive_id`, `status`, `priority`, `progress_phase`, `progress_percent`, `inspection_token`, `inspection_updated_at`, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `created_at`, `updated_at`) SELECT `id`, `detected_disc_id`, `original_disc_archive_id`, `status`, `priority`, CASE WHEN `status` = 'queued' THEN 'waiting' WHEN `status` = 'running' AND `progress_percent` = 0 THEN 'preparing' WHEN `status` = 'running' THEN 'copying' WHEN `status` = 'completed' THEN 'finalizing' WHEN `progress_percent` = 0 THEN 'preparing' ELSE 'copying' END, `progress_percent`, NULL, NULL, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `created_at`, `updated_at` FROM `archive_jobs`;--> statement-breakpoint
DROP TABLE `archive_jobs`;--> statement-breakpoint
ALTER TABLE `__new_archive_jobs` RENAME TO `archive_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `archive_jobs_detected_disc_unique` ON `archive_jobs` (`detected_disc_id`);--> statement-breakpoint
CREATE INDEX `archive_jobs_queue_idx` ON `archive_jobs` (`status`,`priority`,`created_at`);
