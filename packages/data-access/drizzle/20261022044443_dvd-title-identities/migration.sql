CREATE TABLE `dvd_title_identities` (
	`id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_title_identities_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_title_identities_id_not_null" CHECK("id" is not null)
);
--> statement-breakpoint
CREATE TABLE `dvd_title_identity_observations` (
	`id` text PRIMARY KEY,
	`manifest_id` text NOT NULL,
	`title_identity_id` text NOT NULL,
	`previous_observation_id` text,
	`display_title_number` integer NOT NULL,
	`navigation` text NOT NULL,
	`selected_path` text NOT NULL,
	`angle_number` integer NOT NULL,
	`angle_count` integer NOT NULL,
	`chapter_start` integer NOT NULL,
	`chapter_end` integer NOT NULL,
	`chapter_count` integer NOT NULL,
	`source_extents` text NOT NULL,
	`content_digest` text NOT NULL,
	`continuity_result` text NOT NULL,
	`continuity_policy_version` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_title_identity_observations_manifest_id_dvd_title_identity_sets_manifest_id_fk` FOREIGN KEY (`manifest_id`) REFERENCES `dvd_title_identity_sets`(`manifest_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_title_identity_observations_title_identity_id_dvd_title_identities_id_fk` FOREIGN KEY (`title_identity_id`) REFERENCES `dvd_title_identities`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_title_identity_observations_previous_observation_id_dvd_title_identity_observations_id_fk` FOREIGN KEY (`previous_observation_id`) REFERENCES `dvd_title_identity_observations`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_title_identity_observations_id_not_null" CHECK("id" is not null),
	CONSTRAINT "dvd_title_identity_observations_number_check" CHECK(typeof("display_title_number") = 'integer' and "display_title_number" > 0 and typeof("angle_number") = 'integer' and "angle_number" > 0 and typeof("angle_count") = 'integer' and "angle_count" >= "angle_number" and typeof("chapter_start") = 'integer' and "chapter_start" > 0 and typeof("chapter_end") = 'integer' and "chapter_end" >= "chapter_start" and typeof("chapter_count") = 'integer' and "chapter_count" >= "chapter_end"),
	CONSTRAINT "dvd_title_identity_observations_json_check" CHECK(json_valid("navigation") and json_type("navigation") = 'object' and json_valid("selected_path") and json_type("selected_path") = 'array' and json_array_length("selected_path") > 0 and json_valid("source_extents") and json_type("source_extents") = 'array' and json_array_length("source_extents") > 0),
	CONSTRAINT "dvd_title_identity_observations_continuity_check" CHECK("continuity_result" in ('initial', 'proved', 'uncertain', 'new') and (("continuity_result" in ('proved', 'uncertain') and "previous_observation_id" is not null) or ("continuity_result" in ('initial', 'new') and "previous_observation_id" is null)) and length("continuity_policy_version") between 1 and 128 and length("content_digest") = 64 and "content_digest" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TABLE `dvd_title_identity_selection_bindings` (
	`title_identity_id` text NOT NULL,
	`disc_selection_id` text NOT NULL,
	`last_observation_id` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `dvd_title_identity_selection_bindings_pk` PRIMARY KEY(`title_identity_id`, `disc_selection_id`),
	CONSTRAINT `fk_dvd_title_identity_selection_bindings_title_identity_id_dvd_title_identities_id_fk` FOREIGN KEY (`title_identity_id`) REFERENCES `dvd_title_identities`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_title_identity_selection_bindings_disc_selection_id_disc_selections_id_fk` FOREIGN KEY (`disc_selection_id`) REFERENCES `disc_selections`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_title_identity_selection_bindings_last_observation_id_dvd_title_identity_observations_id_fk` FOREIGN KEY (`last_observation_id`) REFERENCES `dvd_title_identity_observations`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_title_identity_selection_bindings_state_check" CHECK("state" in ('mapped', 'needs_mapping_review'))
);
--> statement-breakpoint
CREATE TABLE `dvd_title_identity_sets` (
	`manifest_id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL,
	`manifest_revision` integer NOT NULL,
	`manifest_digest` text NOT NULL,
	`observation_set_digest` text NOT NULL,
	`policy_version` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_title_identity_sets_manifest_id_dvd_archive_evidence_manifests_id_fk` FOREIGN KEY (`manifest_id`) REFERENCES `dvd_archive_evidence_manifests`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_title_identity_sets_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_title_identity_sets_manifest_id_not_null" CHECK("manifest_id" is not null),
	CONSTRAINT "dvd_title_identity_sets_checkpoint_check" CHECK(typeof("manifest_revision") = 'integer' and "manifest_revision" > 0 and length("manifest_digest") = 64 and "manifest_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "dvd_title_identity_sets_evidence_check" CHECK(length("observation_set_digest") = 64 and "observation_set_digest" not glob '*[^0-9a-f]*' and length("policy_version") between 1 and 128)
);
--> statement-breakpoint
CREATE INDEX `dvd_title_identities_archive_idx` ON `dvd_title_identities` (`original_disc_archive_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_title_identity_observations_set_identity_unique` ON `dvd_title_identity_observations` (`manifest_id`,`title_identity_id`);--> statement-breakpoint
CREATE INDEX `dvd_title_identity_observations_content_idx` ON `dvd_title_identity_observations` (`manifest_id`,`content_digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_title_identity_selection_bindings_selection_unique` ON `dvd_title_identity_selection_bindings` (`disc_selection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_title_identity_sets_archive_revision_unique` ON `dvd_title_identity_sets` (`original_disc_archive_id`,`manifest_revision`);--> statement-breakpoint
CREATE TRIGGER `dvd_title_identity_identity_update_guard`
BEFORE UPDATE ON `dvd_title_identities`
BEGIN SELECT RAISE(ABORT, 'DVD Title Identity is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_title_identity_identity_delete_guard`
BEFORE DELETE ON `dvd_title_identities`
BEGIN SELECT RAISE(ABORT, 'DVD Title Identity is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_title_identity_set_update_guard`
BEFORE UPDATE ON `dvd_title_identity_sets`
BEGIN SELECT RAISE(ABORT, 'DVD Title Identity checkpoint set is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_title_identity_set_delete_guard`
BEFORE DELETE ON `dvd_title_identity_sets`
BEGIN SELECT RAISE(ABORT, 'DVD Title Identity checkpoint set is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_title_identity_observation_update_guard`
BEFORE UPDATE ON `dvd_title_identity_observations`
BEGIN SELECT RAISE(ABORT, 'DVD Title Identity observation is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_title_identity_observation_delete_guard`
BEFORE DELETE ON `dvd_title_identity_observations`
BEGIN SELECT RAISE(ABORT, 'DVD Title Identity observation is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_title_identity_binding_insert_guard`
BEFORE INSERT ON `dvd_title_identity_selection_bindings`
WHEN NOT EXISTS (
	SELECT 1
	FROM `dvd_title_identities` AS identity_record
	JOIN `disc_selections` AS selection_record
		ON selection_record.`id` = NEW.`disc_selection_id`
	JOIN `dvd_title_identity_observations` AS observation_record
		ON observation_record.`id` = NEW.`last_observation_id`
	JOIN `dvd_title_identity_sets` AS observation_set
		ON observation_set.`manifest_id` = observation_record.`manifest_id`
	WHERE identity_record.`id` = NEW.`title_identity_id`
		AND observation_record.`title_identity_id` = identity_record.`id`
		AND selection_record.`original_disc_archive_id` = identity_record.`original_disc_archive_id`
		AND observation_set.`original_disc_archive_id` = identity_record.`original_disc_archive_id`
		AND NOT EXISTS (
			SELECT 1
			FROM `dvd_title_identity_observations` AS newer_observation
			JOIN `dvd_title_identity_sets` AS newer_set
				ON newer_set.`manifest_id` = newer_observation.`manifest_id`
			WHERE newer_observation.`title_identity_id` = identity_record.`id`
				AND newer_set.`manifest_revision` > observation_set.`manifest_revision`
		)
)
BEGIN SELECT RAISE(ABORT, 'DVD Title Identity binding does not match its archive evidence'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_title_identity_binding_update_guard`
BEFORE UPDATE ON `dvd_title_identity_selection_bindings`
WHEN NOT EXISTS (
	SELECT 1
	FROM `dvd_title_identities` AS identity_record
	JOIN `disc_selections` AS selection_record
		ON selection_record.`id` = NEW.`disc_selection_id`
	JOIN `dvd_title_identity_observations` AS observation_record
		ON observation_record.`id` = NEW.`last_observation_id`
	JOIN `dvd_title_identity_sets` AS observation_set
		ON observation_set.`manifest_id` = observation_record.`manifest_id`
	WHERE identity_record.`id` = NEW.`title_identity_id`
		AND observation_record.`title_identity_id` = identity_record.`id`
		AND selection_record.`original_disc_archive_id` = identity_record.`original_disc_archive_id`
		AND observation_set.`original_disc_archive_id` = identity_record.`original_disc_archive_id`
		AND NOT EXISTS (
			SELECT 1
			FROM `dvd_title_identity_observations` AS newer_observation
			JOIN `dvd_title_identity_sets` AS newer_set
				ON newer_set.`manifest_id` = newer_observation.`manifest_id`
			WHERE newer_observation.`title_identity_id` = identity_record.`id`
				AND newer_set.`manifest_revision` > observation_set.`manifest_revision`
		)
)
BEGIN SELECT RAISE(ABORT, 'DVD Title Identity binding does not match its archive evidence'); END;
