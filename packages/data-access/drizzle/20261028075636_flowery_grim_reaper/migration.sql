CREATE TABLE `dvd_title_damage_decisions` (
	`id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL,
	`decision` text NOT NULL,
	`operator` text NOT NULL,
	`catalog_revision` integer NOT NULL,
	`checkpoint_revision` integer NOT NULL,
	`checkpoint_digest` text NOT NULL,
	`assessment_identity` text NOT NULL,
	`assessment_attempt_sequence` integer NOT NULL,
	`review_set_identity` text NOT NULL,
	`catalog_mapping_projection_id` text NOT NULL,
	`reviewed_content_identity` text NOT NULL,
	`excluded_title_identity_ids` text NOT NULL,
	`main_feature_resolutions` text NOT NULL,
	`snapshot` text NOT NULL,
	`recorded_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_title_damage_decisions_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_title_damage_decisions_id_not_null" CHECK("id" is not null),
	CONSTRAINT "dvd_title_damage_decisions_decision_check" CHECK("decision" in ('accepted', 'not_required')),
	CONSTRAINT "dvd_title_damage_decisions_operator_check" CHECK(length(trim("operator")) between 1 and 128),
	CONSTRAINT "dvd_title_damage_decisions_checkpoint_check" CHECK(typeof("checkpoint_revision") = 'integer' and "checkpoint_revision" > 0 and length("checkpoint_digest") = 64 and "checkpoint_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "dvd_title_damage_decisions_identities_check" CHECK(length("assessment_identity") between 1 and 128 and typeof("assessment_attempt_sequence") = 'integer' and "assessment_attempt_sequence" > 0 and length("review_set_identity") = 64 and "review_set_identity" not glob '*[^0-9a-f]*' and length("catalog_mapping_projection_id") = 64 and "catalog_mapping_projection_id" not glob '*[^0-9a-f]*' and length("reviewed_content_identity") = 64 and "reviewed_content_identity" not glob '*[^0-9a-f]*'),
	CONSTRAINT "dvd_title_damage_decisions_json_check" CHECK(json_valid("excluded_title_identity_ids") and json_type("excluded_title_identity_ids") = 'array' and json_valid("main_feature_resolutions") and json_type("main_feature_resolutions") = 'array' and json_valid("snapshot") and json_type("snapshot") = 'object')
);
--> statement-breakpoint
CREATE INDEX `dvd_title_damage_decisions_archive_recorded_idx` ON `dvd_title_damage_decisions` (`original_disc_archive_id`,`recorded_at`,`id`);--> statement-breakpoint
CREATE TRIGGER `dvd_title_damage_decisions_update_guard`
BEFORE UPDATE ON `dvd_title_damage_decisions`
BEGIN SELECT RAISE(ABORT, 'Title Damage decisions are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_title_damage_decisions_delete_guard`
BEFORE DELETE ON `dvd_title_damage_decisions`
BEGIN SELECT RAISE(ABORT, 'Title Damage decisions are immutable'); END;
