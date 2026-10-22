CREATE TABLE `dvd_title_damage_assessments` (
	`sequence` integer NOT NULL,
	`id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL,
	`manifest_id` text NOT NULL,
	`manifest_revision` integer NOT NULL,
	`manifest_digest` text NOT NULL,
	`accepted_end_lba_exclusive` integer NOT NULL,
	`title_identity_review_set_identity` text NOT NULL,
	`structural_assessment_identity` text NOT NULL,
	`policy_version` text NOT NULL,
	`title_mappings` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_title_damage_assessments_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_title_damage_assessments_manifest_id_dvd_archive_evidence_manifests_id_fk` FOREIGN KEY (`manifest_id`) REFERENCES `dvd_archive_evidence_manifests`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_title_damage_assessments_structural_assessment_identity_dvd_structural_assessments_id_fk` FOREIGN KEY (`structural_assessment_identity`) REFERENCES `dvd_structural_assessments`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_title_damage_assessments_sequence_check" CHECK(typeof("sequence") = 'integer' and "sequence" > 0),
	CONSTRAINT "dvd_title_damage_assessments_id_not_null" CHECK("id" is not null),
	CONSTRAINT "dvd_title_damage_assessments_identity_check" CHECK(length("id") = 92 and substr("id", 1, 28) = 'dvd-title-damage-assessment:' and substr("id", 29) not glob '*[^0-9a-f]*'),
	CONSTRAINT "dvd_title_damage_assessments_checkpoint_check" CHECK(typeof("manifest_revision") = 'integer' and "manifest_revision" > 0 and length("manifest_digest") = 64 and "manifest_digest" not glob '*[^0-9a-f]*' and typeof("accepted_end_lba_exclusive") = 'integer' and "accepted_end_lba_exclusive" > 0),
	CONSTRAINT "dvd_title_damage_assessments_dependency_check" CHECK(length("title_identity_review_set_identity") = 64 and "title_identity_review_set_identity" not glob '*[^0-9a-f]*' and length("structural_assessment_identity") = 90 and substr("structural_assessment_identity", 1, 26) = 'dvd-structural-assessment:' and substr("structural_assessment_identity", 27) not glob '*[^0-9a-f]*'),
	CONSTRAINT "dvd_title_damage_assessments_policy_check" CHECK("policy_version" = 'dvd-title-damage-assessment-v1'),
	CONSTRAINT "dvd_title_damage_assessments_mappings_check" CHECK(json_valid("title_mappings") and json_type("title_mappings") = 'array')
);
--> statement-breakpoint
CREATE INDEX `dvd_title_damage_assessments_checkpoint_idx` ON `dvd_title_damage_assessments` (`original_disc_archive_id`,`manifest_revision`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_title_damage_assessments_sequence_unique` ON `dvd_title_damage_assessments` (`sequence`);--> statement-breakpoint
CREATE TRIGGER `dvd_title_damage_assessment_update_guard`
BEFORE UPDATE ON `dvd_title_damage_assessments`
BEGIN SELECT RAISE(ABORT, 'DVD Title Damage Assessment is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_title_damage_assessment_delete_guard`
BEFORE DELETE ON `dvd_title_damage_assessments`
BEGIN SELECT RAISE(ABORT, 'DVD Title Damage Assessment is immutable'); END;
