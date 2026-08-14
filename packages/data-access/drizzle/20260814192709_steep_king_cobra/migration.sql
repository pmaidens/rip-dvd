ALTER TABLE `original_disc_archives` ADD `integrity` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `original_disc_archives` ADD `integrity_policy_version` text;--> statement-breakpoint
ALTER TABLE `original_disc_archives` ADD `bad_sector_count` integer;--> statement-breakpoint
ALTER TABLE `original_disc_archives` ADD `bad_area_count` integer;--> statement-breakpoint
ALTER TABLE `original_disc_archives` ADD `bad_sector_ranges` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_original_disc_archives` (
	`id` text PRIMARY KEY,
	`detected_disc_id` text NOT NULL,
	`disc_kind` text NOT NULL,
	`archive_format` text NOT NULL,
	`archive_path` text NOT NULL,
	`fingerprint` text NOT NULL,
	`size_bytes` integer,
	`integrity` text DEFAULT 'unknown' NOT NULL,
	`integrity_policy_version` text,
	`bad_sector_count` integer,
	`bad_area_count` integer,
	`bad_sector_ranges` text,
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
	CONSTRAINT "original_disc_archives_integrity_check" CHECK("integrity" in ('unknown', 'clean_read', 'watchable_salvage')),
	CONSTRAINT "original_disc_archives_integrity_evidence_check" CHECK(("integrity" = 'unknown' and "integrity_policy_version" is null and "bad_sector_count" is null and "bad_area_count" is null and "bad_sector_ranges" is null) or ("integrity" = 'clean_read' and length("integrity_policy_version") between 1 and 128 and "bad_sector_count" = 0 and "bad_area_count" = 0 and json("bad_sector_ranges") = json('[]')) or ("integrity" = 'watchable_salvage' and length("integrity_policy_version") between 1 and 128 and "bad_sector_count" > 0 and "bad_area_count" > 0 and json_valid("bad_sector_ranges") and json_type("bad_sector_ranges") = 'array')),
	CONSTRAINT "original_disc_archives_catalog_review_outcome_check" CHECK("catalog_review_outcome" in ('needs_review', 'reviewed_with_selections', 'archive_only') and ("catalog_review_outcome" = 'needs_review') = ("catalog_reviewed_at" is null)),
	CONSTRAINT "original_disc_archives_verification_check" CHECK(("verification_status" is null) = ("verification_message" is null) and ("verification_status" is null) = ("verified_at" is null) and ("verification_status" is null or "verification_status" in ('accessible', 'missing', 'inaccessible', 'error')))
);
--> statement-breakpoint
INSERT INTO `__new_original_disc_archives`(`id`, `detected_disc_id`, `disc_kind`, `archive_format`, `archive_path`, `fingerprint`, `size_bytes`, `archived_at`, `catalog_reviewed_at`, `catalog_review_outcome`, `legacy_cutover_pending`, `verification_status`, `verification_message`, `verified_at`, `created_at`, `updated_at`) SELECT `id`, `detected_disc_id`, `disc_kind`, `archive_format`, `archive_path`, `fingerprint`, `size_bytes`, `archived_at`, `catalog_reviewed_at`, `catalog_review_outcome`, `legacy_cutover_pending`, `verification_status`, `verification_message`, `verified_at`, `created_at`, `updated_at` FROM `original_disc_archives`;--> statement-breakpoint
DROP TABLE `original_disc_archives`;--> statement-breakpoint
ALTER TABLE `__new_original_disc_archives` RENAME TO `original_disc_archives`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_detected_disc_unique` ON `original_disc_archives` (`detected_disc_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_path_unique` ON `original_disc_archives` (`archive_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_fingerprint_unique` ON `original_disc_archives` (`fingerprint`);