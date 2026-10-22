CREATE TABLE `archive_recovery_work` (
	`archive_recovery_id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL UNIQUE,
	`status` text NOT NULL,
	`requested_at` integer,
	`claimed_by` text,
	`claim_token` text,
	`claimed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_archive_recovery_work_archive_recovery_id_archive_recoveries_id_fk` FOREIGN KEY (`archive_recovery_id`) REFERENCES `archive_recoveries`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_archive_recovery_work_original_disc_archive_id_dvd_archive_evidence_headers_original_disc_archive_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `dvd_archive_evidence_headers`(`original_disc_archive_id`) ON DELETE RESTRICT,
	CONSTRAINT "archive_recovery_work_id_not_null" CHECK("archive_recovery_id" is not null),
	CONSTRAINT "archive_recovery_work_status_check" CHECK("status" in ('requested', 'claimed')),
	CONSTRAINT "archive_recovery_work_claim_check" CHECK(("status" = 'requested' and "requested_at" is not null and "claimed_by" is null and "claim_token" is null and "claimed_at" is null) or ("status" = 'claimed' and "claimed_by" is not null and "claim_token" is not null and "claimed_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `archive_recovery_work_queue_idx` ON `archive_recovery_work` (`status`,`requested_at`,`created_at`);
