PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_encode_jobs` (
	`id` text PRIMARY KEY,
	`disc_selection_id` text NOT NULL,
	`encoding_profile_id` text NOT NULL,
	`output_path` text NOT NULL,
	`reserves_output_path` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`replace_existing_output` integer DEFAULT false NOT NULL,
	`replacement_output_identity` text,
	`partial_cleanup_output_path` text,
	`partial_cleanup_claim_token` text,
	`partial_cleanup_lease_token` text,
	`publication_pending` integer DEFAULT false NOT NULL,
	`publication_completion_pending` integer DEFAULT false NOT NULL,
	`progress_phase` text,
	`progress_percent` integer DEFAULT 0 NOT NULL,
	`progress_eta_seconds` integer,
	`claimed_by` text,
	`claim_token` text,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`error_message` text,
	`verification_status` text,
	`verification_message` text,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_encode_jobs_disc_selection_id_disc_selections_id_fk` FOREIGN KEY (`disc_selection_id`) REFERENCES `disc_selections`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_encode_jobs_encoding_profile_id_encoding_profiles_id_fk` FOREIGN KEY (`encoding_profile_id`) REFERENCES `encoding_profiles`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "encode_jobs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "encode_jobs_status_check" CHECK("status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "encode_jobs_progress_check" CHECK("progress_percent" between 0 and 100),
	CONSTRAINT "encode_jobs_progress_phase_check" CHECK("progress_phase" is null or "progress_phase" in ('scanning', 'previewing', 'encoding')),
	CONSTRAINT "encode_jobs_progress_eta_check" CHECK("progress_eta_seconds" is null or (typeof("progress_eta_seconds") = 'integer' and "progress_eta_seconds" >= 0)),
	CONSTRAINT "encode_jobs_output_reservation_check" CHECK("reserves_output_path" = 1 or "status" = 'failed'),
	CONSTRAINT "encode_jobs_replacement_identity_check" CHECK("replacement_output_identity" is null or "replace_existing_output" = 1),
	CONSTRAINT "encode_jobs_partial_cleanup_pair_check" CHECK(("partial_cleanup_output_path" is null) = ("partial_cleanup_claim_token" is null)),
	CONSTRAINT "encode_jobs_publication_pending_cleanup_check" CHECK("publication_pending" = 0 or "partial_cleanup_claim_token" is not null),
	CONSTRAINT "encode_jobs_publication_completion_pending_check" CHECK("publication_completion_pending" = 0 or "publication_pending" = 1),
	CONSTRAINT "encode_jobs_partial_cleanup_lease_check" CHECK("partial_cleanup_lease_token" is null or "partial_cleanup_claim_token" is not null),
	CONSTRAINT "encode_jobs_verification_check" CHECK(("verification_status" is null and "verification_message" is null and "verified_at" is null) or ("verification_status" in ('accessible', 'missing', 'inaccessible', 'error') and "verification_message" is not null and "verified_at" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_encode_jobs`(`id`, `disc_selection_id`, `encoding_profile_id`, `output_path`, `reserves_output_path`, `status`, `priority`, `replace_existing_output`, `replacement_output_identity`, `partial_cleanup_output_path`, `partial_cleanup_claim_token`, `partial_cleanup_lease_token`, `publication_pending`, `publication_completion_pending`, `progress_phase`, `progress_percent`, `progress_eta_seconds`, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `created_at`, `updated_at`) SELECT `id`, `disc_selection_id`, `encoding_profile_id`, `output_path`, `reserves_output_path`, `status`, `priority`, `replace_existing_output`, `replacement_output_identity`, `partial_cleanup_output_path`, `partial_cleanup_claim_token`, `partial_cleanup_lease_token`, `publication_pending`, `publication_completion_pending`, `progress_phase`, `progress_percent`, `progress_eta_seconds`, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `created_at`, `updated_at` FROM `encode_jobs`;--> statement-breakpoint
DROP TABLE `encode_jobs`;--> statement-breakpoint
ALTER TABLE `__new_encode_jobs` RENAME TO `encode_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_original_disc_archives` (
	`id` text PRIMARY KEY,
	`detected_disc_id` text NOT NULL,
	`disc_kind` text NOT NULL,
	`archive_format` text NOT NULL,
	`archive_path` text NOT NULL,
	`fingerprint` text NOT NULL,
	`size_bytes` integer,
	`archived_at` integer NOT NULL,
	`catalog_reviewed_at` integer,
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
	CONSTRAINT "original_disc_archives_verification_check" CHECK(("verification_status" is null and "verification_message" is null and "verified_at" is null) or ("verification_status" in ('accessible', 'missing', 'inaccessible', 'error') and "verification_message" is not null and "verified_at" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_original_disc_archives`(`id`, `detected_disc_id`, `disc_kind`, `archive_format`, `archive_path`, `fingerprint`, `size_bytes`, `archived_at`, `catalog_reviewed_at`, `legacy_cutover_pending`, `created_at`, `updated_at`) SELECT `id`, `detected_disc_id`, `disc_kind`, `archive_format`, `archive_path`, `fingerprint`, `size_bytes`, `archived_at`, `catalog_reviewed_at`, `legacy_cutover_pending`, `created_at`, `updated_at` FROM `original_disc_archives`;--> statement-breakpoint
DROP TABLE `original_disc_archives`;--> statement-breakpoint
ALTER TABLE `__new_original_disc_archives` RENAME TO `original_disc_archives`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `encode_jobs_selection_profile_unique` ON `encode_jobs` (`disc_selection_id`,`encoding_profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `encode_jobs_output_path_unique` ON `encode_jobs` (`output_path`) WHERE "encode_jobs"."reserves_output_path" = 1;--> statement-breakpoint
CREATE INDEX `encode_jobs_queue_idx` ON `encode_jobs` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_detected_disc_unique` ON `original_disc_archives` (`detected_disc_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_path_unique` ON `original_disc_archives` (`archive_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_fingerprint_unique` ON `original_disc_archives` (`fingerprint`);
