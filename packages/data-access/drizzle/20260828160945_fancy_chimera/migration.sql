PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_original_disc_archives` (
	`id` text PRIMARY KEY,
	`detected_disc_id` text NOT NULL,
	`disc_kind` text NOT NULL,
	`archive_format` text NOT NULL,
	`archive_path` text NOT NULL,
	`fingerprint` text NOT NULL,
	`size_bytes` integer,
	`boundary_policy_version` text,
	`boundary_reported_size_bytes` integer,
	`boundary_published_size_bytes` integer,
	`boundary_excluded_sector_count` integer,
	`boundary_first_excluded_lba` integer,
	`boundary_maximum_referenced_lba` integer,
	`boundary_read_failure_classifier_version` text,
	`boundary_read_failure_scsi_status` integer,
	`boundary_read_failure_host_status` integer,
	`boundary_read_failure_driver_status` integer,
	`boundary_read_failure_sense_response_code` integer,
	`boundary_read_failure_sense_key` integer,
	`boundary_read_failure_asc` integer,
	`boundary_read_failure_ascq` integer,
	`integrity` text DEFAULT 'unknown' NOT NULL,
	`integrity_policy_version` text,
	`bad_sector_count` integer,
	`bad_area_count` integer,
	`bad_sector_ranges` text,
	`bad_sector_counts_by_title` text,
	`archived_at` integer NOT NULL,
	`catalog_reviewed_at` integer,
	`catalog_review_outcome` text DEFAULT 'needs_review' NOT NULL,
	`legacy_cutover_pending` integer DEFAULT false NOT NULL,
	`verification_status` text,
	`verification_message` text,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_original_disc_archives_detected_disc_id_detected_discs_id_fk` FOREIGN KEY (`detected_disc_id`) REFERENCES `detected_discs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "original_disc_archives_id_not_null" CHECK("id" is not null),
	CONSTRAINT "original_disc_archives_kind_check" CHECK("disc_kind" in ('dvd', 'blu_ray', 'audio_cd')),
	CONSTRAINT "original_disc_archives_format_check" CHECK("archive_format" in ('iso')),
	CONSTRAINT "original_disc_archives_size_check" CHECK("size_bytes" is null or "size_bytes" >= 0),
	CONSTRAINT "original_disc_archives_boundary_evidence_check" CHECK(("boundary_policy_version" is null and "boundary_reported_size_bytes" is null and "boundary_published_size_bytes" is null and "boundary_excluded_sector_count" is null and "boundary_first_excluded_lba" is null and "boundary_maximum_referenced_lba" is null and "boundary_read_failure_classifier_version" is null and "boundary_read_failure_scsi_status" is null and "boundary_read_failure_host_status" is null and "boundary_read_failure_driver_status" is null and "boundary_read_failure_sense_response_code" is null and "boundary_read_failure_sense_key" is null and "boundary_read_failure_asc" is null and "boundary_read_failure_ascq" is null) or ("disc_kind" = 'dvd' and typeof("boundary_policy_version") = 'text' and length("boundary_policy_version") between 1 and 128 and typeof("boundary_reported_size_bytes") = 'integer' and "boundary_reported_size_bytes" between 1 and 9000000000 and typeof("size_bytes") = 'integer' and typeof("boundary_published_size_bytes") = 'integer' and "boundary_published_size_bytes" = "size_bytes" and typeof("boundary_excluded_sector_count") = 'integer' and (("boundary_published_size_bytes" = "boundary_reported_size_bytes" and "boundary_excluded_sector_count" = 0 and "boundary_first_excluded_lba" is null and "boundary_maximum_referenced_lba" is null and "boundary_read_failure_classifier_version" is null and "boundary_read_failure_scsi_status" is null and "boundary_read_failure_host_status" is null and "boundary_read_failure_driver_status" is null and "boundary_read_failure_sense_response_code" is null and "boundary_read_failure_sense_key" is null and "boundary_read_failure_asc" is null and "boundary_read_failure_ascq" is null) or ("boundary_reported_size_bytes" % 2048 = 0 and "boundary_published_size_bytes" % 2048 = 0 and "boundary_published_size_bytes" between 2048 and "boundary_reported_size_bytes" - 2048 and "boundary_excluded_sector_count" = ("boundary_reported_size_bytes" - "boundary_published_size_bytes") / 2048 and typeof("boundary_first_excluded_lba") = 'integer' and "boundary_first_excluded_lba" = "boundary_published_size_bytes" / 2048 and typeof("boundary_maximum_referenced_lba") = 'integer' and "boundary_maximum_referenced_lba" between 0 and "boundary_first_excluded_lba" - 1 and typeof("boundary_read_failure_classifier_version") = 'text' and length("boundary_read_failure_classifier_version") between 1 and 128 and typeof("boundary_read_failure_scsi_status") = 'integer' and ("boundary_read_failure_scsi_status" & 254) = 2 and typeof("boundary_read_failure_host_status") = 'integer' and "boundary_read_failure_host_status" = 0 and typeof("boundary_read_failure_driver_status") = 'integer' and ("boundary_read_failure_driver_status" & 15) in (0, 8) and typeof("boundary_read_failure_sense_response_code") = 'integer' and "boundary_read_failure_sense_response_code" in (112, 114) and typeof("boundary_read_failure_sense_key") = 'integer' and "boundary_read_failure_sense_key" = 5 and typeof("boundary_read_failure_asc") = 'integer' and "boundary_read_failure_asc" = 33 and typeof("boundary_read_failure_ascq") = 'integer' and "boundary_read_failure_ascq" = 0)))),
	CONSTRAINT "original_disc_archives_integrity_check" CHECK("integrity" in ('unknown', 'clean_read', 'watchable_salvage')),
	CONSTRAINT "original_disc_archives_integrity_evidence_check" CHECK(("integrity" = 'unknown' and "integrity_policy_version" is null and "bad_sector_count" is null and "bad_area_count" is null and "bad_sector_ranges" is null and "bad_sector_counts_by_title" is null) or ("integrity" = 'clean_read' and "integrity_policy_version" is not null and "bad_sector_count" is not null and "bad_area_count" is not null and "bad_sector_ranges" is not null and "bad_sector_counts_by_title" is null and length("integrity_policy_version") between 1 and 128 and "bad_sector_count" = 0 and "bad_area_count" = 0 and json("bad_sector_ranges") = json('[]')) or ("integrity" = 'watchable_salvage' and "integrity_policy_version" is not null and "bad_sector_count" is not null and "bad_area_count" is not null and "bad_sector_ranges" is not null and length("integrity_policy_version") between 1 and 128 and "bad_sector_count" > 0 and "bad_area_count" > 0 and json_valid("bad_sector_ranges") and json_type("bad_sector_ranges") = 'array' and ("integrity_policy_version" = 'dvd-watchable-salvage-v1' or ("bad_sector_counts_by_title" is not null and json_valid("bad_sector_counts_by_title") and json_type("bad_sector_counts_by_title") = 'array')))),
	CONSTRAINT "original_disc_archives_catalog_review_outcome_check" CHECK("catalog_review_outcome" in ('needs_review', 'reviewed_with_selections', 'archive_only') and ("catalog_review_outcome" = 'needs_review') = ("catalog_reviewed_at" is null)),
	CONSTRAINT "original_disc_archives_verification_check" CHECK(("verification_status" is null) = ("verification_message" is null) and ("verification_status" is null) = ("verified_at" is null) and ("verification_status" is null or "verification_status" in ('accessible', 'missing', 'inaccessible', 'error')))
);
--> statement-breakpoint
INSERT INTO `__new_original_disc_archives`(`id`, `detected_disc_id`, `disc_kind`, `archive_format`, `archive_path`, `fingerprint`, `size_bytes`, `boundary_policy_version`, `boundary_reported_size_bytes`, `boundary_published_size_bytes`, `boundary_excluded_sector_count`, `boundary_first_excluded_lba`, `boundary_maximum_referenced_lba`, `boundary_read_failure_classifier_version`, `boundary_read_failure_scsi_status`, `boundary_read_failure_host_status`, `boundary_read_failure_driver_status`, `boundary_read_failure_sense_response_code`, `boundary_read_failure_sense_key`, `boundary_read_failure_asc`, `boundary_read_failure_ascq`, `integrity`, `integrity_policy_version`, `bad_sector_count`, `bad_area_count`, `bad_sector_ranges`, `bad_sector_counts_by_title`, `archived_at`, `catalog_reviewed_at`, `catalog_review_outcome`, `legacy_cutover_pending`, `verification_status`, `verification_message`, `verified_at`, `created_at`, `updated_at`) SELECT `id`, `detected_disc_id`, `disc_kind`, `archive_format`, `archive_path`, `fingerprint`, `size_bytes`, `boundary_policy_version`, `boundary_reported_size_bytes`, `boundary_published_size_bytes`, `boundary_excluded_sector_count`, `boundary_first_excluded_lba`, `boundary_maximum_referenced_lba`, `boundary_read_failure_classifier_version`, `boundary_read_failure_scsi_status`, `boundary_read_failure_host_status`, `boundary_read_failure_driver_status`, `boundary_read_failure_sense_response_code`, `boundary_read_failure_sense_key`, `boundary_read_failure_asc`, `boundary_read_failure_ascq`, `integrity`, `integrity_policy_version`, `bad_sector_count`, `bad_area_count`, `bad_sector_ranges`, `bad_sector_counts_by_title`, `archived_at`, `catalog_reviewed_at`, `catalog_review_outcome`, `legacy_cutover_pending`, `verification_status`, `verification_message`, `verified_at`, `created_at`, `updated_at` FROM `original_disc_archives`;--> statement-breakpoint
DROP TABLE `original_disc_archives`;--> statement-breakpoint
ALTER TABLE `__new_original_disc_archives` RENAME TO `original_disc_archives`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_detected_disc_unique` ON `original_disc_archives` (`detected_disc_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_path_unique` ON `original_disc_archives` (`archive_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_fingerprint_unique` ON `original_disc_archives` (`fingerprint`);