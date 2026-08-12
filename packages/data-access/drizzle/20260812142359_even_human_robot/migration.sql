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
	CONSTRAINT "encode_jobs_status_check" CHECK("status" in ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "encode_jobs_progress_check" CHECK("progress_percent" between 0 and 100),
	CONSTRAINT "encode_jobs_progress_phase_check" CHECK("progress_phase" is null or "progress_phase" in ('scanning', 'previewing', 'encoding')),
	CONSTRAINT "encode_jobs_progress_eta_check" CHECK("progress_eta_seconds" is null or (typeof("progress_eta_seconds") = 'integer' and "progress_eta_seconds" >= 0)),
	CONSTRAINT "encode_jobs_output_reservation_check" CHECK("reserves_output_path" = 1 or "status" in ('failed', 'cancelled')),
	CONSTRAINT "encode_jobs_replacement_identity_check" CHECK("replacement_output_identity" is null or "replace_existing_output" = 1),
	CONSTRAINT "encode_jobs_partial_cleanup_pair_check" CHECK(("partial_cleanup_output_path" is null) = ("partial_cleanup_claim_token" is null)),
	CONSTRAINT "encode_jobs_publication_pending_cleanup_check" CHECK("publication_pending" = 0 or "partial_cleanup_claim_token" is not null),
	CONSTRAINT "encode_jobs_publication_completion_pending_check" CHECK("publication_completion_pending" = 0 or "publication_pending" = 1),
	CONSTRAINT "encode_jobs_partial_cleanup_lease_check" CHECK("partial_cleanup_lease_token" is null or "partial_cleanup_claim_token" is not null),
	CONSTRAINT "encode_jobs_verification_check" CHECK(("verification_status" is null) = ("verification_message" is null) and ("verification_status" is null) = ("verified_at" is null) and ("verification_status" is null or "verification_status" in ('accessible', 'missing', 'inaccessible', 'error')))
);
--> statement-breakpoint
INSERT INTO `__new_encode_jobs`(`id`, `disc_selection_id`, `encoding_profile_id`, `output_path`, `reserves_output_path`, `status`, `priority`, `replace_existing_output`, `replacement_output_identity`, `partial_cleanup_output_path`, `partial_cleanup_claim_token`, `partial_cleanup_lease_token`, `publication_pending`, `publication_completion_pending`, `progress_phase`, `progress_percent`, `progress_eta_seconds`, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `verification_status`, `verification_message`, `verified_at`, `created_at`, `updated_at`) SELECT `id`, `disc_selection_id`, `encoding_profile_id`, `output_path`, `reserves_output_path`, `status`, `priority`, `replace_existing_output`, `replacement_output_identity`, `partial_cleanup_output_path`, `partial_cleanup_claim_token`, `partial_cleanup_lease_token`, `publication_pending`, `publication_completion_pending`, `progress_phase`, `progress_percent`, `progress_eta_seconds`, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `verification_status`, `verification_message`, `verified_at`, `created_at`, `updated_at` FROM `encode_jobs`;--> statement-breakpoint
DROP TABLE `encode_jobs`;--> statement-breakpoint
ALTER TABLE `__new_encode_jobs` RENAME TO `encode_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `encode_jobs_selection_profile_unique` ON `encode_jobs` (`disc_selection_id`,`encoding_profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `encode_jobs_output_path_unique` ON `encode_jobs` (`output_path`) WHERE "encode_jobs"."reserves_output_path" = 1;--> statement-breakpoint
CREATE INDEX `encode_jobs_queue_idx` ON `encode_jobs` (`status`,`priority`,`created_at`);