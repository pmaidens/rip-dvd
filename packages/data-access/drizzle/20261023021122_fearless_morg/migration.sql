ALTER TABLE `dvd_disc_verifications` ADD `admitted_device_path` text;--> statement-breakpoint
ALTER TABLE `dvd_disc_verifications` ADD `admitted_device_id` text;--> statement-breakpoint
ALTER TABLE `dvd_disc_verifications` ADD `admitted_device_inode` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_dvd_disc_verifications` (
	`id` text PRIMARY KEY,
	`archive_recovery_id` text NOT NULL,
	`archive_recovery_attempt_id` text,
	`attempt_ordinal` integer NOT NULL,
	`original_disc_archive_id` text NOT NULL,
	`disc_inspection_id` text NOT NULL,
	`detected_disc_id` text NOT NULL,
	`media_generation` text NOT NULL,
	`source_metadata_fingerprint` text NOT NULL,
	`observed_metadata_fingerprint` text NOT NULL,
	`checkpoint_revision` integer NOT NULL,
	`checkpoint_digest` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text,
	`reasons` text NOT NULL,
	`findings` text NOT NULL,
	`budget_exhausted` integer DEFAULT false NOT NULL,
	`worker_execution_id` text,
	`claim_token` text,
	`claimed_at` integer,
	`admitted_device_path` text,
	`admitted_device_id` text,
	`admitted_device_inode` text,
	`started_at` integer,
	`completed_at` integer,
	`failure_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_disc_verifications_archive_recovery_id_archive_recoveries_id_fk` FOREIGN KEY (`archive_recovery_id`) REFERENCES `archive_recoveries`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_disc_verifications_original_disc_archive_id_dvd_archive_evidence_headers_original_disc_archive_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `dvd_archive_evidence_headers`(`original_disc_archive_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_disc_verifications_disc_inspection_id_disc_inspections_id_fk` FOREIGN KEY (`disc_inspection_id`) REFERENCES `disc_inspections`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_disc_verifications_detected_disc_id_detected_discs_id_fk` FOREIGN KEY (`detected_disc_id`) REFERENCES `detected_discs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_disc_verifications_id_not_null" CHECK("id" is not null),
	CONSTRAINT "dvd_disc_verifications_status_check" CHECK("status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "dvd_disc_verifications_checkpoint_check" CHECK(typeof("checkpoint_revision") = 'integer' and "checkpoint_revision" > 0 and length("checkpoint_digest") = 64 and "checkpoint_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "dvd_disc_verifications_attempt_check" CHECK(typeof("attempt_ordinal") = 'integer' and "attempt_ordinal" > 0 and ("archive_recovery_attempt_id" is null or length("archive_recovery_attempt_id") > 0)),
	CONSTRAINT "dvd_disc_verifications_json_check" CHECK(json_valid("reasons") and json_type("reasons") = 'array' and json_valid("findings") and json_type("findings") = 'array'),
	CONSTRAINT "dvd_disc_verifications_result_check" CHECK(("status" in ('queued', 'running') and "outcome" is null and "completed_at" is null and "failure_code" is null) or ("status" = 'completed' and "outcome" in ('match', 'mismatch', 'inconclusive') and "completed_at" is not null and "failure_code" is null) or ("status" = 'failed' and "outcome" is null and "completed_at" is not null and "failure_code" = 'DISC_VERIFICATION_UNAVAILABLE')),
	CONSTRAINT "dvd_disc_verifications_claim_check" CHECK(("status" = 'running' and "claim_token" is not null and "claimed_at" is not null and "worker_execution_id" is not null and "started_at" is not null) or ("status" <> 'running' and "claim_token" is null and "claimed_at" is null)),
	CONSTRAINT "dvd_disc_verifications_device_identity_check" CHECK(("admitted_device_path" is null and "admitted_device_id" is null and "admitted_device_inode" is null) or ("admitted_device_path" is not null and length("admitted_device_path") > 0 and "admitted_device_id" is not null and length("admitted_device_id") > 0 and "admitted_device_inode" is not null and length("admitted_device_inode") > 0))
);
--> statement-breakpoint
INSERT INTO `__new_dvd_disc_verifications`(`id`, `archive_recovery_id`, `archive_recovery_attempt_id`, `attempt_ordinal`, `original_disc_archive_id`, `disc_inspection_id`, `detected_disc_id`, `media_generation`, `source_metadata_fingerprint`, `observed_metadata_fingerprint`, `checkpoint_revision`, `checkpoint_digest`, `status`, `outcome`, `reasons`, `findings`, `budget_exhausted`, `worker_execution_id`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `failure_code`, `created_at`, `updated_at`) SELECT `id`, `archive_recovery_id`, `archive_recovery_attempt_id`, `attempt_ordinal`, `original_disc_archive_id`, `disc_inspection_id`, `detected_disc_id`, `media_generation`, `source_metadata_fingerprint`, `observed_metadata_fingerprint`, `checkpoint_revision`, `checkpoint_digest`, `status`, `outcome`, `reasons`, `findings`, `budget_exhausted`, `worker_execution_id`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `failure_code`, `created_at`, `updated_at` FROM `dvd_disc_verifications`;--> statement-breakpoint
DROP TABLE `dvd_disc_verifications`;--> statement-breakpoint
ALTER TABLE `__new_dvd_disc_verifications` RENAME TO `dvd_disc_verifications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_disc_verifications_recovery_attempt_unique` ON `dvd_disc_verifications` (`archive_recovery_id`,`attempt_ordinal`);--> statement-breakpoint
CREATE INDEX `dvd_disc_verifications_status_created_idx` ON `dvd_disc_verifications` (`status`,`created_at`,`id`);