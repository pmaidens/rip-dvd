PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_retained_encode_outputs` (
	`id` text PRIMARY KEY,
	`predecessor_encode_job_id` text NOT NULL,
	`replacement_encode_job_id` text NOT NULL,
	`source_encode_job_id` text NOT NULL,
	`retained_output_path` text NOT NULL,
	`filesystem_identity` text NOT NULL,
	`state` text DEFAULT 'retained' NOT NULL,
	`cleanup_eligible` integer DEFAULT true NOT NULL,
	`retained_at` integer NOT NULL,
	CONSTRAINT `fk_retained_encode_outputs_predecessor_encode_job_id_encode_jobs_id_fk` FOREIGN KEY (`predecessor_encode_job_id`) REFERENCES `encode_jobs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_retained_encode_outputs_replacement_encode_job_id_encode_jobs_id_fk` FOREIGN KEY (`replacement_encode_job_id`) REFERENCES `encode_jobs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_retained_encode_outputs_source_encode_job_id_encode_jobs_id_fk` FOREIGN KEY (`source_encode_job_id`) REFERENCES `encode_jobs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "retained_encode_outputs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "retained_encode_outputs_distinct_jobs_check" CHECK("predecessor_encode_job_id" <> "replacement_encode_job_id"),
	CONSTRAINT "retained_encode_outputs_source_job_check" CHECK("source_encode_job_id" in ("predecessor_encode_job_id", "replacement_encode_job_id")),
	CONSTRAINT "retained_encode_outputs_state_check" CHECK("state" in ('retained')),
	CONSTRAINT "retained_encode_outputs_cleanup_eligible_check" CHECK("cleanup_eligible" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_retained_encode_outputs`(`id`, `predecessor_encode_job_id`, `replacement_encode_job_id`, `source_encode_job_id`, `retained_output_path`, `filesystem_identity`, `state`, `cleanup_eligible`, `retained_at`) SELECT `id`, `predecessor_encode_job_id`, `replacement_encode_job_id`, CASE WHEN row_number() OVER (PARTITION BY `predecessor_encode_job_id`, `replacement_encode_job_id` ORDER BY rowid) = 1 THEN `predecessor_encode_job_id` ELSE `replacement_encode_job_id` END, `retained_output_path`, `filesystem_identity`, `state`, `cleanup_eligible`, `retained_at` FROM `retained_encode_outputs`;--> statement-breakpoint
DROP TABLE `retained_encode_outputs`;--> statement-breakpoint
ALTER TABLE `__new_retained_encode_outputs` RENAME TO `retained_encode_outputs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `retained_encode_outputs_replacement_idx` ON `retained_encode_outputs` (`replacement_encode_job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `retained_encode_outputs_path_unique` ON `retained_encode_outputs` (`retained_output_path`);--> statement-breakpoint
CREATE INDEX `retained_encode_outputs_predecessor_idx` ON `retained_encode_outputs` (`predecessor_encode_job_id`);
