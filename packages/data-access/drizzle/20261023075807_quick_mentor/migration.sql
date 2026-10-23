CREATE TABLE `dvd_disc_confirmations` (
	`id` text PRIMARY KEY,
	`archive_recovery_id` text NOT NULL,
	`archive_recovery_attempt_id` text NOT NULL,
	`original_disc_archive_id` text NOT NULL,
	`verification_id` text NOT NULL,
	`disc_inspection_id` text NOT NULL,
	`detected_disc_id` text NOT NULL,
	`media_generation` text NOT NULL,
	`verification_worker_execution_id` text NOT NULL,
	`verification_outcome` text NOT NULL,
	`verification_result_digest` text NOT NULL,
	`checkpoint_revision` integer NOT NULL,
	`checkpoint_digest` text NOT NULL,
	`acknowledged_mixed_source` integer NOT NULL,
	`expired_at` integer,
	`expiry_reason` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_disc_confirmations_archive_recovery_id_archive_recoveries_id_fk` FOREIGN KEY (`archive_recovery_id`) REFERENCES `archive_recoveries`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_disc_confirmations_original_disc_archive_id_dvd_archive_evidence_headers_original_disc_archive_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `dvd_archive_evidence_headers`(`original_disc_archive_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_disc_confirmations_verification_id_dvd_disc_verifications_id_fk` FOREIGN KEY (`verification_id`) REFERENCES `dvd_disc_verifications`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_disc_confirmations_disc_inspection_id_disc_inspections_id_fk` FOREIGN KEY (`disc_inspection_id`) REFERENCES `disc_inspections`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_disc_confirmations_detected_disc_id_detected_discs_id_fk` FOREIGN KEY (`detected_disc_id`) REFERENCES `detected_discs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_disc_confirmations_id_not_null" CHECK("id" is not null),
	CONSTRAINT "dvd_disc_confirmations_identity_check" CHECK("archive_recovery_attempt_id" is not null and length("archive_recovery_attempt_id") > 0 and length("media_generation") > 0 and length("verification_worker_execution_id") > 0),
	CONSTRAINT "dvd_disc_confirmations_result_check" CHECK("verification_outcome" in ('mismatch', 'inconclusive') and length("verification_result_digest") = 64 and "verification_result_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "dvd_disc_confirmations_checkpoint_check" CHECK(typeof("checkpoint_revision") = 'integer' and "checkpoint_revision" > 0 and length("checkpoint_digest") = 64 and "checkpoint_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "dvd_disc_confirmations_acknowledgement_check" CHECK("acknowledged_mixed_source" = true),
	CONSTRAINT "dvd_disc_confirmations_expiry_check" CHECK(("expired_at" is null and "expiry_reason" is null) or ("expired_at" is not null and "expiry_reason" in ('RECOVERY_ATTEMPT_CHANGED', 'DISC_INSERTION_CHANGED', 'WORKER_EXECUTION_CHANGED', 'DISC_CHECKPOINT_CHANGED', 'DISC_VERIFICATION_CHANGED', 'DISC_VERIFICATION_RESULT_CHANGED', 'DISC_SOURCE_CHANGED')))
);
--> statement-breakpoint
ALTER TABLE `archive_recovery_work` ADD `disc_confirmation_id` text REFERENCES dvd_disc_confirmations(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `dvd_archive_recovery_reads` ADD `verification_id` text REFERENCES dvd_disc_verifications(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `dvd_archive_recovery_reads` ADD `disc_confirmation_id` text REFERENCES dvd_disc_confirmations(id) ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX `dvd_archive_recovery_reads_confirmation_outcome_lba_idx` ON `dvd_archive_recovery_reads` (`disc_confirmation_id`,`outcome`,`start_lba`);--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_disc_confirmations_verification_unique` ON `dvd_disc_confirmations` (`verification_id`);--> statement-breakpoint
CREATE INDEX `dvd_disc_confirmations_recovery_created_idx` ON `dvd_disc_confirmations` (`archive_recovery_id`,`created_at`,`id`);