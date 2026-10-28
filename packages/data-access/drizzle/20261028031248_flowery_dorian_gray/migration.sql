CREATE TABLE `catalog_review_evidence_choices` (
	`id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL,
	`choice` text NOT NULL,
	`catalog_revision` integer NOT NULL,
	`checkpoint_revision` integer NOT NULL,
	`checkpoint_digest` text NOT NULL,
	`archive_recovery_id` text NOT NULL,
	`archive_recovery_attempt_id` text NOT NULL,
	`archive_recovery_status` text NOT NULL,
	`recorded_at` integer NOT NULL,
	CONSTRAINT `fk_catalog_review_evidence_choices_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `catalog_review_evidence_choices_recovery_fk` FOREIGN KEY (`archive_recovery_id`,`original_disc_archive_id`) REFERENCES `archive_recoveries`(`id`,`original_disc_archive_id`) ON DELETE RESTRICT,
	CONSTRAINT "catalog_review_evidence_choices_id_not_null" CHECK("id" is not null),
	CONSTRAINT "catalog_review_evidence_choices_choice_check" CHECK("choice" in ('archive_only', 'reopen')),
	CONSTRAINT "catalog_review_evidence_choices_checkpoint_revision_check" CHECK(typeof("checkpoint_revision") = 'integer' and "checkpoint_revision" > 0),
	CONSTRAINT "catalog_review_evidence_choices_checkpoint_digest_check" CHECK(length("checkpoint_digest") = 64 and "checkpoint_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "catalog_review_evidence_choices_recovery_identity_check" CHECK(length(trim("archive_recovery_id")) > 0 and length(trim("archive_recovery_attempt_id")) > 0),
	CONSTRAINT "catalog_review_evidence_choices_recovery_status_check" CHECK("archive_recovery_status" in ('eligible', 'waiting_for_disc', 'running', 'paused', 'stopping', 'stopped', 'completed', 'faulted')),
	CONSTRAINT "catalog_review_evidence_choices_timestamp_check" CHECK(typeof("catalog_revision") = 'integer' and typeof("recorded_at") = 'integer')
);
--> statement-breakpoint
CREATE INDEX `catalog_review_evidence_choices_archive_revision_idx` ON `catalog_review_evidence_choices` (`original_disc_archive_id`,`catalog_revision`,`id`);--> statement-breakpoint
CREATE TRIGGER `catalog_review_evidence_choices_insert_guard`
BEFORE INSERT ON `catalog_review_evidence_choices`
WHEN NOT EXISTS (
	SELECT 1
	FROM `original_disc_archives` AS archive
	INNER JOIN `dvd_archive_evidence_headers` AS evidence
		ON evidence.`original_disc_archive_id` = archive.`id`
	INNER JOIN `archive_recoveries` AS recovery
		ON recovery.`original_disc_archive_id` = archive.`id`
	WHERE archive.`id` = NEW.`original_disc_archive_id`
		AND archive.`updated_at` = NEW.`catalog_revision`
		AND evidence.`current_manifest_revision` = NEW.`checkpoint_revision`
		AND evidence.`current_manifest_digest` = NEW.`checkpoint_digest`
		AND recovery.`id` = NEW.`archive_recovery_id`
		AND recovery.`attempt_id` = NEW.`archive_recovery_attempt_id`
		AND recovery.`status` = NEW.`archive_recovery_status`
		AND (
			(NEW.`choice` = 'archive_only'
				AND archive.`catalog_review_outcome` = 'needs_review'
				AND recovery.`status` IN ('stopped', 'completed'))
			OR
			(NEW.`choice` = 'reopen'
				AND archive.`catalog_review_outcome` = 'archive_only'
				AND recovery.`status` <> 'faulted')
		)
)
BEGIN SELECT RAISE(ABORT, 'Catalog Review evidence choice is inconsistent'); END;--> statement-breakpoint
CREATE TRIGGER `catalog_review_evidence_choices_update_guard`
BEFORE UPDATE ON `catalog_review_evidence_choices`
BEGIN SELECT RAISE(ABORT, 'Catalog Review evidence choices are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `catalog_review_evidence_choices_delete_guard`
BEFORE DELETE ON `catalog_review_evidence_choices`
BEGIN SELECT RAISE(ABORT, 'Catalog Review evidence choices are immutable'); END;
