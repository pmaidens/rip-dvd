CREATE TABLE `dvd_recovery_reconciliations` (
	`id` text PRIMARY KEY,
	`archive_recovery_id` text NOT NULL,
	`attempt_ordinal` integer NOT NULL,
	`original_disc_archive_id` text NOT NULL,
	`status` text NOT NULL,
	`phase` text NOT NULL,
	`outcome` text,
	`evidence` text,
	`failure_code` text,
	`worker_execution_id` text,
	`claim_token` text,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `dvd_recovery_reconciliations_recovery_archive_fk` FOREIGN KEY (`archive_recovery_id`,`original_disc_archive_id`) REFERENCES `archive_recoveries`(`id`,`original_disc_archive_id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_recovery_reconciliations_id_not_null" CHECK("id" is not null),
	CONSTRAINT "dvd_recovery_reconciliations_attempt_ordinal_check" CHECK(typeof("attempt_ordinal") = 'integer' and "attempt_ordinal" > 0),
	CONSTRAINT "dvd_recovery_reconciliations_status_check" CHECK("status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "dvd_recovery_reconciliations_phase_check" CHECK("phase" in ('queued', 'examining', 'rolling_back', 'projecting', 'cleaning_up', 'completed')),
	CONSTRAINT "dvd_recovery_reconciliations_result_check" CHECK(("status" in ('queued', 'running') and "outcome" is null and "evidence" is null and "failure_code" is null and "completed_at" is null) or ("status" = 'completed' and "phase" = 'completed' and "outcome" in ('already_consistent', 'rolled_back', 'rolled_forward', 'cleaned_up') and "evidence" is not null and json_valid("evidence") and json_type("evidence") = 'object' and "failure_code" is null and "completed_at" is not null) or ("status" = 'failed' and "phase" = 'completed' and "outcome" is null and "evidence" is null and "failure_code" in ('CONSISTENCY_FAULT', 'WRITER_NOT_QUIESCENT', 'STORAGE_UNSUPPORTED') and "completed_at" is not null)),
	CONSTRAINT "dvd_recovery_reconciliations_claim_check" CHECK(("status" = 'running' and "worker_execution_id" is not null and "claim_token" is not null and "claimed_at" is not null and "started_at" is not null and "phase" <> 'queued' and "phase" <> 'completed') or ("status" <> 'running' and "claim_token" is null and "claimed_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_recovery_reconciliations_active_unique` ON `dvd_recovery_reconciliations` (`archive_recovery_id`) WHERE "dvd_recovery_reconciliations"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_recovery_reconciliations_attempt_unique` ON `dvd_recovery_reconciliations` (`archive_recovery_id`,`attempt_ordinal`);--> statement-breakpoint
CREATE INDEX `dvd_recovery_reconciliations_status_created_idx` ON `dvd_recovery_reconciliations` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `dvd_recovery_reconciliations_recovery_created_idx` ON `dvd_recovery_reconciliations` (`archive_recovery_id`,`created_at`,`id`);