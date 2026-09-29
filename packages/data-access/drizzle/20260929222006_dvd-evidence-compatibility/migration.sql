CREATE TABLE `archive_recoveries` (
	`id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_archive_recoveries_original_disc_archive_id_dvd_archive_evidence_headers_original_disc_archive_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `dvd_archive_evidence_headers`(`original_disc_archive_id`) ON DELETE RESTRICT,
	CONSTRAINT "archive_recoveries_id_not_null" CHECK("id" is not null),
	CONSTRAINT "archive_recoveries_status_check" CHECK("status" in ('eligible', 'completed'))
);
--> statement-breakpoint
CREATE TABLE `dvd_archive_evidence_headers` (
	`original_disc_archive_id` text PRIMARY KEY,
	`source_archive_job_id` text NOT NULL,
	`evidence_format` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_archive_evidence_headers_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_archive_evidence_headers_source_archive_job_id_archive_jobs_id_fk` FOREIGN KEY (`source_archive_job_id`) REFERENCES `archive_jobs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_archive_evidence_headers_archive_id_not_null" CHECK("original_disc_archive_id" is not null),
	CONSTRAINT "dvd_archive_evidence_headers_format_check" CHECK("evidence_format" in ('dvd-recovery-evidence-v1'))
);
--> statement-breakpoint
ALTER TABLE `archive_jobs` ADD `evidence_format` text;--> statement-breakpoint
ALTER TABLE `archive_requests` ADD `evidence_format` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_archive_jobs` (
	`id` text PRIMARY KEY,
	`archive_request_id` text NOT NULL,
	`disc_inspection_id` text,
	`detected_disc_id` text NOT NULL,
	`original_disc_archive_id` text,
	`evidence_format` text,
	`attempt_ordinal` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`progress_phase` text DEFAULT 'preparing' NOT NULL,
	`progress_percent` integer DEFAULT 0 NOT NULL,
	`progress_bytes` integer DEFAULT 0 NOT NULL,
	`progress_eta_seconds` integer,
	`last_progress_at` integer NOT NULL,
	`claimed_by` text,
	`claim_token` text,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`error_message` text,
	`failure_detail_version` text,
	`read_failure_stage` text,
	`read_failure_category` text,
	`read_failure_classifier_version` text,
	`read_failure_lba` integer,
	`read_failure_requested_block_count` integer,
	`read_failure_retry_count` integer,
	`read_failure_scsi_status` integer,
	`read_failure_host_status` integer,
	`read_failure_driver_status` integer,
	`read_failure_sense_key` integer,
	`read_failure_asc` integer,
	`read_failure_ascq` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_archive_jobs_archive_request_id_archive_requests_id_fk` FOREIGN KEY (`archive_request_id`) REFERENCES `archive_requests`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_archive_jobs_disc_inspection_id_disc_inspections_id_fk` FOREIGN KEY (`disc_inspection_id`) REFERENCES `disc_inspections`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_archive_jobs_detected_disc_id_detected_discs_id_fk` FOREIGN KEY (`detected_disc_id`) REFERENCES `detected_discs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_archive_jobs_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "archive_jobs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "archive_jobs_status_check" CHECK("status" in ('running', 'completed', 'failed', 'aborted')),
	CONSTRAINT "archive_jobs_evidence_format_check" CHECK("evidence_format" is null or "evidence_format" in ('dvd-recovery-evidence-v1')),
	CONSTRAINT "archive_jobs_progress_check" CHECK("progress_percent" between 0 and 100),
	CONSTRAINT "archive_jobs_progress_bytes_check" CHECK(typeof("progress_bytes") = 'integer' and "progress_bytes" >= 0),
	CONSTRAINT "archive_jobs_progress_eta_check" CHECK("progress_eta_seconds" is null or (typeof("progress_eta_seconds") = 'integer' and "progress_eta_seconds" >= 0)),
	CONSTRAINT "archive_jobs_progress_phase_check" CHECK("progress_phase" in ('preparing', 'copying', 'verifying', 'finalizing')),
	CONSTRAINT "archive_jobs_attempt_ordinal_check" CHECK(typeof("attempt_ordinal") = 'integer' and "attempt_ordinal" > 0),
	CONSTRAINT "archive_jobs_attempt_shape_check" CHECK(("status" = 'running' and "claimed_by" is not null and "claim_token" is not null and "claimed_at" is not null and "started_at" is not null and "completed_at" is null) or ("status" <> 'running' and "started_at" is not null and "completed_at" is not null)),
	CONSTRAINT "archive_jobs_failure_detail_version_check" CHECK("failure_detail_version" is null or ("status" = 'failed' and "failure_detail_version" in ('archive-failure-detail-v1'))),
	CONSTRAINT "archive_jobs_read_failure_shape_check" CHECK(("read_failure_category" is null and "read_failure_stage" is null and "read_failure_classifier_version" is null and "read_failure_lba" is null and "read_failure_requested_block_count" is null and "read_failure_retry_count" is null and "read_failure_scsi_status" is null and "read_failure_host_status" is null and "read_failure_driver_status" is null and "read_failure_sense_key" is null and "read_failure_asc" is null and "read_failure_ascq" is null) or ("status" = 'failed' and "read_failure_stage" in ('initial_copy', 'rescue_resume') and "read_failure_category" in ('unknown', 'not_ready', 'unit_attention', 'hardware_error', 'transport_error', 'protection_error', 'out_of_range') and typeof("read_failure_classifier_version") = 'text' and length("read_failure_classifier_version") between 1 and 128 and typeof("read_failure_lba") = 'integer' and "read_failure_lba" >= 0 and typeof("read_failure_requested_block_count") = 'integer' and "read_failure_requested_block_count" between 1 and 4294967295 and typeof("read_failure_retry_count") = 'integer' and "read_failure_retry_count" between 0 and 4294967295 and ("read_failure_scsi_status" is null or (typeof("read_failure_scsi_status") = 'integer' and "read_failure_scsi_status" between 0 and 255)) and ("read_failure_host_status" is null or (typeof("read_failure_host_status") = 'integer' and "read_failure_host_status" between 0 and 65535)) and ("read_failure_driver_status" is null or (typeof("read_failure_driver_status") = 'integer' and "read_failure_driver_status" between 0 and 65535)) and ("read_failure_sense_key" is null or (typeof("read_failure_sense_key") = 'integer' and "read_failure_sense_key" between 0 and 15)) and ("read_failure_asc" is null or (typeof("read_failure_asc") = 'integer' and "read_failure_asc" between 0 and 255)) and ("read_failure_ascq" is null or (typeof("read_failure_ascq") = 'integer' and "read_failure_ascq" between 0 and 255)) and (("read_failure_scsi_status" is null and "read_failure_host_status" is null and "read_failure_driver_status" is null) or ("read_failure_scsi_status" is not null and "read_failure_host_status" is not null and "read_failure_driver_status" is not null)) and (("read_failure_asc" is null and "read_failure_ascq" is null) or ("read_failure_asc" is not null and "read_failure_ascq" is not null)))),
	CONSTRAINT "archive_jobs_read_failure_category_evidence_check" CHECK("read_failure_category" is null or "read_failure_category" = 'unknown' or ("read_failure_category" = 'not_ready' and "read_failure_scsi_status" is not null and "read_failure_host_status" is not null and "read_failure_driver_status" is not null and "read_failure_sense_key" is not null and ("read_failure_scsi_status" & 254) = 2 and "read_failure_host_status" = 0 and ("read_failure_driver_status" & 15) in (0, 8) and "read_failure_sense_key" = 2 and "read_failure_asc" is not null and "read_failure_ascq" is not null) or ("read_failure_category" = 'unit_attention' and "read_failure_scsi_status" is not null and "read_failure_host_status" is not null and "read_failure_driver_status" is not null and "read_failure_sense_key" is not null and ("read_failure_scsi_status" & 254) = 2 and "read_failure_host_status" = 0 and ("read_failure_driver_status" & 15) in (0, 8) and "read_failure_sense_key" = 6 and "read_failure_asc" is not null and "read_failure_ascq" is not null) or ("read_failure_category" = 'hardware_error' and "read_failure_scsi_status" is not null and "read_failure_host_status" is not null and "read_failure_driver_status" is not null and "read_failure_sense_key" is not null and ("read_failure_scsi_status" & 254) = 2 and "read_failure_host_status" = 0 and ("read_failure_driver_status" & 15) in (0, 8) and "read_failure_sense_key" = 4 and "read_failure_asc" is not null and "read_failure_ascq" is not null) or ("read_failure_category" = 'transport_error' and "read_failure_scsi_status" is not null and "read_failure_host_status" is not null and "read_failure_driver_status" is not null and ("read_failure_host_status" <> 0 or ("read_failure_host_status" = 0 and ("read_failure_driver_status" & 15) in (1, 2, 4, 6)))) or ("read_failure_category" = 'protection_error' and "read_failure_scsi_status" is not null and "read_failure_host_status" is not null and "read_failure_driver_status" is not null and "read_failure_sense_key" is not null and ("read_failure_scsi_status" & 254) = 2 and "read_failure_host_status" = 0 and ("read_failure_driver_status" & 15) in (0, 8) and "read_failure_asc" is not null and "read_failure_ascq" is not null and ("read_failure_sense_key" = 7 or ("read_failure_sense_key" = 5 and "read_failure_asc" = 111))) or ("read_failure_category" = 'out_of_range' and "read_failure_scsi_status" is not null and "read_failure_host_status" is not null and "read_failure_driver_status" is not null and "read_failure_sense_key" is not null and ("read_failure_scsi_status" & 254) = 2 and "read_failure_host_status" = 0 and ("read_failure_driver_status" & 15) in (0, 8) and "read_failure_sense_key" = 5 and "read_failure_asc" = 33 and "read_failure_ascq" = 0))
);
--> statement-breakpoint
INSERT INTO `__new_archive_jobs`(`id`, `archive_request_id`, `disc_inspection_id`, `detected_disc_id`, `original_disc_archive_id`, `attempt_ordinal`, `status`, `priority`, `progress_phase`, `progress_percent`, `progress_bytes`, `progress_eta_seconds`, `last_progress_at`, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `failure_detail_version`, `read_failure_stage`, `read_failure_category`, `read_failure_classifier_version`, `read_failure_lba`, `read_failure_requested_block_count`, `read_failure_retry_count`, `read_failure_scsi_status`, `read_failure_host_status`, `read_failure_driver_status`, `read_failure_sense_key`, `read_failure_asc`, `read_failure_ascq`, `created_at`, `updated_at`) SELECT `id`, `archive_request_id`, `disc_inspection_id`, `detected_disc_id`, `original_disc_archive_id`, `attempt_ordinal`, `status`, `priority`, `progress_phase`, `progress_percent`, `progress_bytes`, `progress_eta_seconds`, `last_progress_at`, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `failure_detail_version`, `read_failure_stage`, `read_failure_category`, `read_failure_classifier_version`, `read_failure_lba`, `read_failure_requested_block_count`, `read_failure_retry_count`, `read_failure_scsi_status`, `read_failure_host_status`, `read_failure_driver_status`, `read_failure_sense_key`, `read_failure_asc`, `read_failure_ascq`, `created_at`, `updated_at` FROM `archive_jobs`;--> statement-breakpoint
DROP TABLE `archive_jobs`;--> statement-breakpoint
ALTER TABLE `__new_archive_jobs` RENAME TO `archive_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_archive_requests` (
	`id` text PRIMARY KEY,
	`detected_disc_id` text NOT NULL,
	`rearchive_source_archive_id` text,
	`evidence_format` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`cancellation_requested_at` integer,
	`fulfilled_at` integer,
	`cancelled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_archive_requests_detected_disc_id_detected_discs_id_fk` FOREIGN KEY (`detected_disc_id`) REFERENCES `detected_discs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_archive_requests_rearchive_source_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`rearchive_source_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "archive_requests_id_not_null" CHECK("id" is not null),
	CONSTRAINT "archive_requests_status_check" CHECK("status" in ('pending', 'running', 'needs_attention', 'cancellation_requested', 'fulfilled', 'cancelled')),
	CONSTRAINT "archive_requests_evidence_format_check" CHECK("evidence_format" is null or "evidence_format" in ('dvd-recovery-evidence-v1')),
	CONSTRAINT "archive_requests_terminal_fields_check" CHECK(("fulfilled_at" is not null) = ("status" = 'fulfilled') and ("cancelled_at" is not null) = ("status" = 'cancelled') and ("cancellation_requested_at" is not null) = ("status" in ('cancellation_requested', 'cancelled')))
);
--> statement-breakpoint
INSERT INTO `__new_archive_requests`(`id`, `detected_disc_id`, `rearchive_source_archive_id`, `status`, `priority`, `cancellation_requested_at`, `fulfilled_at`, `cancelled_at`, `created_at`, `updated_at`) SELECT `id`, `detected_disc_id`, `rearchive_source_archive_id`, `status`, `priority`, `cancellation_requested_at`, `fulfilled_at`, `cancelled_at`, `created_at`, `updated_at` FROM `archive_requests`;--> statement-breakpoint
DROP TABLE `archive_requests`;--> statement-breakpoint
ALTER TABLE `__new_archive_requests` RENAME TO `archive_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_original_disc_archives` (
	`id` text PRIMARY KEY,
	`detected_disc_id` text NOT NULL,
	`rearchive_source_archive_id` text,
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
	CONSTRAINT `fk_original_disc_archives_rearchive_source_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`rearchive_source_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "original_disc_archives_id_not_null" CHECK("id" is not null),
	CONSTRAINT "original_disc_archives_rearchive_source_check" CHECK("rearchive_source_archive_id" is null or "rearchive_source_archive_id" <> "id"),
	CONSTRAINT "original_disc_archives_kind_check" CHECK("disc_kind" in ('dvd', 'blu_ray', 'audio_cd')),
	CONSTRAINT "original_disc_archives_format_check" CHECK("archive_format" in ('iso')),
	CONSTRAINT "original_disc_archives_size_check" CHECK("size_bytes" is null or "size_bytes" >= 0),
	CONSTRAINT "original_disc_archives_boundary_evidence_check" CHECK(("boundary_policy_version" is null and "boundary_reported_size_bytes" is null and "boundary_published_size_bytes" is null and "boundary_excluded_sector_count" is null and "boundary_first_excluded_lba" is null and "boundary_maximum_referenced_lba" is null and "boundary_read_failure_classifier_version" is null and "boundary_read_failure_scsi_status" is null and "boundary_read_failure_host_status" is null and "boundary_read_failure_driver_status" is null and "boundary_read_failure_sense_response_code" is null and "boundary_read_failure_sense_key" is null and "boundary_read_failure_asc" is null and "boundary_read_failure_ascq" is null) or ("disc_kind" = 'dvd' and typeof("boundary_reported_size_bytes") = 'integer' and "boundary_reported_size_bytes" between 1 and 9000000000 and typeof("size_bytes") = 'integer' and typeof("boundary_published_size_bytes") = 'integer' and "boundary_published_size_bytes" = "size_bytes" and typeof("boundary_excluded_sector_count") = 'integer' and (("boundary_policy_version" = 'dvd-archive-boundary-v1' and "boundary_published_size_bytes" = "boundary_reported_size_bytes" and "boundary_excluded_sector_count" = 0 and "boundary_first_excluded_lba" is null and "boundary_maximum_referenced_lba" is null and "boundary_read_failure_classifier_version" is null and "boundary_read_failure_scsi_status" is null and "boundary_read_failure_host_status" is null and "boundary_read_failure_driver_status" is null and "boundary_read_failure_sense_response_code" is null and "boundary_read_failure_sense_key" is null and "boundary_read_failure_asc" is null and "boundary_read_failure_ascq" is null) or ("boundary_policy_version" = 'dvd-archive-boundary-v2' and "boundary_reported_size_bytes" % 2048 = 0 and "boundary_published_size_bytes" = "boundary_reported_size_bytes" and "boundary_excluded_sector_count" = 0 and typeof("boundary_first_excluded_lba") = 'integer' and "boundary_first_excluded_lba" = "boundary_published_size_bytes" / 2048 and "boundary_maximum_referenced_lba" is null and typeof("boundary_read_failure_classifier_version") = 'text' and length("boundary_read_failure_classifier_version") between 1 and 128 and typeof("boundary_read_failure_scsi_status") = 'integer' and "boundary_read_failure_scsi_status" between 0 and 255 and ("boundary_read_failure_scsi_status" & 254) = 2 and typeof("boundary_read_failure_host_status") = 'integer' and "boundary_read_failure_host_status" = 0 and typeof("boundary_read_failure_driver_status") = 'integer' and "boundary_read_failure_driver_status" between 0 and 65535 and ("boundary_read_failure_driver_status" & 15) in (0, 8) and typeof("boundary_read_failure_sense_response_code") = 'integer' and "boundary_read_failure_sense_response_code" in (112, 114) and typeof("boundary_read_failure_sense_key") = 'integer' and "boundary_read_failure_sense_key" = 5 and typeof("boundary_read_failure_asc") = 'integer' and "boundary_read_failure_asc" = 33 and typeof("boundary_read_failure_ascq") = 'integer' and "boundary_read_failure_ascq" = 0) or ("boundary_policy_version" = 'dvd-archive-boundary-v1' and "boundary_reported_size_bytes" % 2048 = 0 and "boundary_published_size_bytes" % 2048 = 0 and "boundary_published_size_bytes" between 2048 and "boundary_reported_size_bytes" - 2048 and "boundary_excluded_sector_count" = ("boundary_reported_size_bytes" - "boundary_published_size_bytes") / 2048 and typeof("boundary_first_excluded_lba") = 'integer' and "boundary_first_excluded_lba" = "boundary_published_size_bytes" / 2048 and typeof("boundary_maximum_referenced_lba") = 'integer' and "boundary_maximum_referenced_lba" between 0 and "boundary_first_excluded_lba" - 1 and typeof("boundary_read_failure_classifier_version") = 'text' and length("boundary_read_failure_classifier_version") between 1 and 128 and typeof("boundary_read_failure_scsi_status") = 'integer' and "boundary_read_failure_scsi_status" between 0 and 255 and ("boundary_read_failure_scsi_status" & 254) = 2 and typeof("boundary_read_failure_host_status") = 'integer' and "boundary_read_failure_host_status" = 0 and typeof("boundary_read_failure_driver_status") = 'integer' and "boundary_read_failure_driver_status" between 0 and 65535 and ("boundary_read_failure_driver_status" & 15) in (0, 8) and typeof("boundary_read_failure_sense_response_code") = 'integer' and "boundary_read_failure_sense_response_code" in (112, 114) and typeof("boundary_read_failure_sense_key") = 'integer' and "boundary_read_failure_sense_key" = 5 and typeof("boundary_read_failure_asc") = 'integer' and "boundary_read_failure_asc" = 33 and typeof("boundary_read_failure_ascq") = 'integer' and "boundary_read_failure_ascq" = 0)))),
	CONSTRAINT "original_disc_archives_boundary_policy_version_check" CHECK(("boundary_policy_version" is null and "boundary_reported_size_bytes" is null) or (typeof("boundary_policy_version") = 'text' and "boundary_policy_version" in ('dvd-archive-boundary-v1', 'dvd-archive-boundary-v2') and "boundary_reported_size_bytes" is not null)),
	CONSTRAINT "original_disc_archives_integrity_check" CHECK("integrity" in ('unknown', 'clean_read', 'incomplete_read', 'watchable_salvage')),
	CONSTRAINT "original_disc_archives_integrity_evidence_check" CHECK(("integrity" = 'unknown' and "integrity_policy_version" is null and "bad_sector_count" is null and "bad_area_count" is null and "bad_sector_ranges" is null and "bad_sector_counts_by_title" is null) or ("integrity" = 'clean_read' and "integrity_policy_version" is not null and "bad_sector_count" is not null and "bad_area_count" is not null and "bad_sector_ranges" is not null and "bad_sector_counts_by_title" is null and length("integrity_policy_version") between 1 and 128 and "bad_sector_count" = 0 and "bad_area_count" = 0 and json("bad_sector_ranges") = json('[]')) or ("integrity" = 'incomplete_read' and "integrity_policy_version" = 'dvd-recovery-evidence-v1' and typeof("bad_sector_count") = 'integer' and "bad_sector_count" > 0 and typeof("bad_area_count") = 'integer' and "bad_area_count" > 0 and "bad_sector_ranges" is not null and json_valid("bad_sector_ranges") and json_type("bad_sector_ranges") = 'array' and "bad_sector_counts_by_title" is null) or ("integrity" = 'watchable_salvage' and "integrity_policy_version" is not null and "bad_sector_count" is not null and "bad_area_count" is not null and "bad_sector_ranges" is not null and length("integrity_policy_version") between 1 and 128 and "bad_sector_count" > 0 and "bad_area_count" > 0 and json_valid("bad_sector_ranges") and json_type("bad_sector_ranges") = 'array' and ("integrity_policy_version" = 'dvd-watchable-salvage-v1' or ("bad_sector_counts_by_title" is not null and json_valid("bad_sector_counts_by_title") and json_type("bad_sector_counts_by_title") = 'array')))),
	CONSTRAINT "original_disc_archives_catalog_review_outcome_check" CHECK("catalog_review_outcome" in ('needs_review', 'reviewed_with_selections', 'archive_only') and ("catalog_review_outcome" = 'needs_review') = ("catalog_reviewed_at" is null)),
	CONSTRAINT "original_disc_archives_verification_check" CHECK(("verification_status" is null) = ("verification_message" is null) and ("verification_status" is null) = ("verified_at" is null) and ("verification_status" is null or "verification_status" in ('accessible', 'missing', 'inaccessible', 'error')))
);
--> statement-breakpoint
INSERT INTO `__new_original_disc_archives`(`id`, `detected_disc_id`, `rearchive_source_archive_id`, `disc_kind`, `archive_format`, `archive_path`, `fingerprint`, `size_bytes`, `boundary_policy_version`, `boundary_reported_size_bytes`, `boundary_published_size_bytes`, `boundary_excluded_sector_count`, `boundary_first_excluded_lba`, `boundary_maximum_referenced_lba`, `boundary_read_failure_classifier_version`, `boundary_read_failure_scsi_status`, `boundary_read_failure_host_status`, `boundary_read_failure_driver_status`, `boundary_read_failure_sense_response_code`, `boundary_read_failure_sense_key`, `boundary_read_failure_asc`, `boundary_read_failure_ascq`, `integrity`, `integrity_policy_version`, `bad_sector_count`, `bad_area_count`, `bad_sector_ranges`, `bad_sector_counts_by_title`, `archived_at`, `catalog_reviewed_at`, `catalog_review_outcome`, `legacy_cutover_pending`, `verification_status`, `verification_message`, `verified_at`, `created_at`, `updated_at`) SELECT `id`, `detected_disc_id`, `rearchive_source_archive_id`, `disc_kind`, `archive_format`, `archive_path`, `fingerprint`, `size_bytes`, `boundary_policy_version`, `boundary_reported_size_bytes`, `boundary_published_size_bytes`, `boundary_excluded_sector_count`, `boundary_first_excluded_lba`, `boundary_maximum_referenced_lba`, `boundary_read_failure_classifier_version`, `boundary_read_failure_scsi_status`, `boundary_read_failure_host_status`, `boundary_read_failure_driver_status`, `boundary_read_failure_sense_response_code`, `boundary_read_failure_sense_key`, `boundary_read_failure_asc`, `boundary_read_failure_ascq`, `integrity`, `integrity_policy_version`, `bad_sector_count`, `bad_area_count`, `bad_sector_ranges`, `bad_sector_counts_by_title`, `archived_at`, `catalog_reviewed_at`, `catalog_review_outcome`, `legacy_cutover_pending`, `verification_status`, `verification_message`, `verified_at`, `created_at`, `updated_at` FROM `original_disc_archives`;--> statement-breakpoint
DROP TABLE `original_disc_archives`;--> statement-breakpoint
ALTER TABLE `__new_original_disc_archives` RENAME TO `original_disc_archives`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `archive_jobs_request_attempt_unique` ON `archive_jobs` (`archive_request_id`,`attempt_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `archive_jobs_running_request_unique` ON `archive_jobs` (`archive_request_id`) WHERE "archive_jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `archive_jobs_request_idx` ON `archive_jobs` (`archive_request_id`,`attempt_ordinal`);--> statement-breakpoint
CREATE INDEX `archive_jobs_inspection_created_idx` ON `archive_jobs` (`disc_inspection_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `archive_jobs_archive_created_idx` ON `archive_jobs` (`original_disc_archive_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `archive_jobs_disc_created_idx` ON `archive_jobs` (`detected_disc_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `archive_requests_nonterminal_disc_unique` ON `archive_requests` (`detected_disc_id`) WHERE "archive_requests"."status" in ('pending', 'running', 'needs_attention', 'cancellation_requested');--> statement-breakpoint
CREATE INDEX `archive_requests_disc_created_idx` ON `archive_requests` (`detected_disc_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `archive_requests_rearchive_source_idx` ON `archive_requests` (`rearchive_source_archive_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `archive_requests_status_idx` ON `archive_requests` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `original_disc_archives_detected_disc_idx` ON `original_disc_archives` (`detected_disc_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_detected_disc_unique` ON `original_disc_archives` (`detected_disc_id`) WHERE "original_disc_archives"."rearchive_source_archive_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_path_unique` ON `original_disc_archives` (`archive_path`);--> statement-breakpoint
CREATE INDEX `original_disc_archives_fingerprint_idx` ON `original_disc_archives` (`fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_fingerprint_unique` ON `original_disc_archives` (`fingerprint`) WHERE "original_disc_archives"."rearchive_source_archive_id" is null;--> statement-breakpoint
CREATE INDEX `original_disc_archives_rearchive_source_idx` ON `original_disc_archives` (`rearchive_source_archive_id`,`archived_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `archive_recoveries_archive_unique` ON `archive_recoveries` (`original_disc_archive_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_archive_evidence_headers_job_unique` ON `dvd_archive_evidence_headers` (`source_archive_job_id`);
