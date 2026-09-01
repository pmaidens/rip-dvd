PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_encode_job_failure_reports` (
	`id` text PRIMARY KEY,
	`encode_job_id` text NOT NULL,
	`schema_version` integer NOT NULL,
	`worker_kind` text DEFAULT 'encode_worker' NOT NULL,
	`reason_code` text NOT NULL,
	`phase` text NOT NULL,
	`retryability` text NOT NULL,
	`diagnostic` text,
	`exit_status` integer,
	`signal` text,
	`timeout_seconds` integer,
	`validation_check` text,
	`expected_seconds` real,
	`observed_seconds` real,
	`context` text,
	`sequence` integer NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_encode_job_failure_reports_encode_job_id_encode_jobs_id_fk` FOREIGN KEY (`encode_job_id`) REFERENCES `encode_jobs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "encode_job_failure_reports_id_not_null" CHECK("id" is not null),
	CONSTRAINT "encode_job_failure_reports_schema_version_check" CHECK("schema_version" in (1)),
	CONSTRAINT "encode_job_failure_reports_worker_kind_check" CHECK("worker_kind" = 'encode_worker'),
	CONSTRAINT "encode_job_failure_reports_reason_code_check" CHECK("reason_code" in ('input_unavailable', 'invalid_configuration', 'output_conflict', 'unsafe_output_state', 'command_failed', 'command_timeout', 'output_validation_failed', 'unknown_failure', 'cleanup_failed', 'publication_failed', 'lease_expired', 'worker_interrupted', 'publication_recovery_failed')),
	CONSTRAINT "encode_job_failure_reports_phase_check" CHECK("phase" in ('preparation', 'scanning', 'previewing', 'encoding', 'validation', 'cleanup', 'publication', 'recovery')),
	CONSTRAINT "encode_job_failure_reports_retryability_check" CHECK("retryability" in ('appropriate', 'after_action', 'not_appropriate')),
	CONSTRAINT "encode_job_failure_reports_diagnostic_check" CHECK("diagnostic" is null or (typeof("diagnostic") = 'text' and length("diagnostic") between 1 and 500)),
	CONSTRAINT "encode_job_failure_reports_sequence_check" CHECK(typeof("sequence") = 'integer' and "sequence" >= 1),
	CONSTRAINT "encode_job_failure_reports_evidence_check" CHECK(("reason_code" = 'command_failed' and "timeout_seconds" is null and "validation_check" is null and "expected_seconds" is null and "observed_seconds" is null and "context" is null and ((typeof("exit_status") = 'integer' and "exit_status" between 1 and 255 and "signal" is null) or ("exit_status" is null and "signal" in ('SIGABRT', 'SIGALRM', 'SIGBREAK', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGIO', 'SIGIOT', 'SIGKILL', 'SIGLOST', 'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT', 'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGUNUSED', 'SIGURG', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ', 'SIGINFO')))) or ("reason_code" = 'command_timeout' and "exit_status" is null and "signal" is null and typeof("timeout_seconds") = 'integer' and "timeout_seconds" between 1 and 604800 and "validation_check" is null and "expected_seconds" is null and "observed_seconds" is null and "context" is null) or ("reason_code" = 'output_validation_failed' and "exit_status" is null and "signal" is null and "timeout_seconds" is null and "context" is null and (("validation_check" in ('subtitle_streams', 'subtitle_packets', 'subtitle_cleanup', 'video_metadata', 'duration_metadata', 'video_packets', 'audio_timing', 'video_decode', 'output_file') and "expected_seconds" is null and "observed_seconds" is null) or ("validation_check" is null and typeof("expected_seconds") in ('integer', 'real') and "expected_seconds" > 0 and "expected_seconds" <= 604800 and typeof("observed_seconds") in ('integer', 'real') and "observed_seconds" >= 0 and "observed_seconds" <= 604800))) or ("reason_code" in ('input_unavailable', 'invalid_configuration', 'output_conflict', 'unsafe_output_state', 'unknown_failure') and "exit_status" is null and "signal" is null and "timeout_seconds" is null and "validation_check" is null and "expected_seconds" is null and "observed_seconds" is null and "context" is null) or ("reason_code" = 'cleanup_failed' and "exit_status" is null and "signal" is null and "timeout_seconds" is null and "validation_check" is null and "expected_seconds" is null and "observed_seconds" is null and "context" in ('partial_output', 'replacement_artifact', 'published_output', 'publication_completion')) or ("reason_code" = 'publication_failed' and "exit_status" is null and "signal" is null and "timeout_seconds" is null and "validation_check" is null and "expected_seconds" is null and "observed_seconds" is null and "context" in ('publication_mutation', 'publication_completion')) or ("reason_code" = 'lease_expired' and "exit_status" is null and "signal" is null and "timeout_seconds" is null and "validation_check" is null and "expected_seconds" is null and "observed_seconds" is null and "context" in ('job_claim', 'publication_cleanup')) or ("reason_code" = 'worker_interrupted' and "exit_status" is null and "signal" is null and "timeout_seconds" is null and "validation_check" is null and "expected_seconds" is null and "observed_seconds" is null and "context" in ('worker_shutdown', 'publication_completion')) or ("reason_code" = 'publication_recovery_failed' and "exit_status" is null and "signal" is null and "timeout_seconds" is null and "validation_check" is null and "expected_seconds" is null and "observed_seconds" is null and "context" in ('publication_recovery', 'cleanup_recovery'))),
	CONSTRAINT "encode_job_failure_reports_reason_phase_check" CHECK("reason_code" in ('input_unavailable', 'invalid_configuration', 'output_conflict', 'unsafe_output_state', 'output_validation_failed', 'unknown_failure') or ("reason_code" in ('command_failed', 'command_timeout') and "phase" in ('scanning', 'previewing', 'encoding') and "retryability" = 'appropriate') or ("reason_code" = 'cleanup_failed' and "phase" = 'cleanup' and "retryability" = 'after_action') or ("reason_code" = 'publication_failed' and "phase" = 'publication' and "retryability" = 'after_action') or ("reason_code" = 'lease_expired' and "retryability" = 'after_action' and (("context" = 'publication_cleanup' and "phase" in ('publication', 'cleanup')) or ("context" = 'job_claim' and "phase" in ('preparation', 'scanning', 'previewing', 'encoding', 'validation', 'publication')))) or ("reason_code" = 'worker_interrupted' and "retryability" = 'after_action' and (("context" = 'publication_completion' and "phase" = 'publication') or ("context" = 'worker_shutdown' and "phase" in ('preparation', 'scanning', 'previewing', 'encoding', 'validation', 'publication')))) or ("reason_code" = 'publication_recovery_failed' and "phase" = 'recovery' and "retryability" = 'after_action'))
);
--> statement-breakpoint
INSERT INTO `__new_encode_job_failure_reports`(`id`, `encode_job_id`, `schema_version`, `worker_kind`, `reason_code`, `phase`, `retryability`, `diagnostic`, `exit_status`, `signal`, `timeout_seconds`, `validation_check`, `expected_seconds`, `observed_seconds`, `context`, `sequence`, `occurred_at`, `created_at`) SELECT `id`, `encode_job_id`, `schema_version`, `worker_kind`, `reason_code`, `phase`, `retryability`, `diagnostic`, `exit_status`, `signal`, `timeout_seconds`, `validation_check`, `expected_seconds`, `observed_seconds`, null, row_number() over (partition by `encode_job_id` order by `occurred_at`, `id`), `occurred_at`, `created_at` FROM `encode_job_failure_reports`;--> statement-breakpoint
DROP TABLE `encode_job_failure_reports`;--> statement-breakpoint
ALTER TABLE `__new_encode_job_failure_reports` RENAME TO `encode_job_failure_reports`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_encode_jobs` (
	`id` text PRIMARY KEY,
	`predecessor_encode_job_id` text,
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
	CONSTRAINT `fk_encode_jobs_predecessor_encode_job_id_encode_jobs_id_fk` FOREIGN KEY (`predecessor_encode_job_id`) REFERENCES `encode_jobs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_encode_jobs_disc_selection_id_disc_selections_id_fk` FOREIGN KEY (`disc_selection_id`) REFERENCES `disc_selections`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_encode_jobs_encoding_profile_id_encoding_profiles_id_fk` FOREIGN KEY (`encoding_profile_id`) REFERENCES `encoding_profiles`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "encode_jobs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "encode_jobs_status_check" CHECK("status" in ('queued', 'running', 'cancellation_requested', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "encode_jobs_progress_check" CHECK("progress_percent" between 0 and 100),
	CONSTRAINT "encode_jobs_progress_phase_check" CHECK("progress_phase" is null or "progress_phase" in ('scanning', 'previewing', 'encoding', 'validation')),
	CONSTRAINT "encode_jobs_progress_eta_check" CHECK("progress_eta_seconds" is null or (typeof("progress_eta_seconds") = 'integer' and "progress_eta_seconds" >= 0)),
	CONSTRAINT "encode_jobs_output_reservation_check" CHECK("reserves_output_path" = 1 or "status" in ('cancellation_requested', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "encode_jobs_predecessor_distinct_check" CHECK("predecessor_encode_job_id" is null or "predecessor_encode_job_id" <> "id"),
	CONSTRAINT "encode_jobs_replacement_identity_check" CHECK("replacement_output_identity" is null or "replace_existing_output" = 1),
	CONSTRAINT "encode_jobs_partial_cleanup_pair_check" CHECK(("partial_cleanup_output_path" is null) = ("partial_cleanup_claim_token" is null)),
	CONSTRAINT "encode_jobs_publication_pending_cleanup_check" CHECK("publication_pending" = 0 or "partial_cleanup_claim_token" is not null),
	CONSTRAINT "encode_jobs_publication_completion_pending_check" CHECK("publication_completion_pending" = 0 or "publication_pending" = 1),
	CONSTRAINT "encode_jobs_partial_cleanup_lease_check" CHECK("partial_cleanup_lease_token" is null or "partial_cleanup_claim_token" is not null),
	CONSTRAINT "encode_jobs_verification_check" CHECK(("verification_status" is null) = ("verification_message" is null) and ("verification_status" is null) = ("verified_at" is null) and ("verification_status" is null or "verification_status" in ('accessible', 'missing', 'inaccessible', 'error')))
);
--> statement-breakpoint
INSERT INTO `__new_encode_jobs`(`id`, `predecessor_encode_job_id`, `disc_selection_id`, `encoding_profile_id`, `output_path`, `reserves_output_path`, `status`, `priority`, `replace_existing_output`, `replacement_output_identity`, `partial_cleanup_output_path`, `partial_cleanup_claim_token`, `partial_cleanup_lease_token`, `publication_pending`, `publication_completion_pending`, `progress_phase`, `progress_percent`, `progress_eta_seconds`, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `verification_status`, `verification_message`, `verified_at`, `created_at`, `updated_at`) SELECT `id`, `predecessor_encode_job_id`, `disc_selection_id`, `encoding_profile_id`, `output_path`, `reserves_output_path`, `status`, `priority`, `replace_existing_output`, `replacement_output_identity`, `partial_cleanup_output_path`, `partial_cleanup_claim_token`, `partial_cleanup_lease_token`, `publication_pending`, `publication_completion_pending`, `progress_phase`, `progress_percent`, `progress_eta_seconds`, `claimed_by`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `error_message`, `verification_status`, `verification_message`, `verified_at`, `created_at`, `updated_at` FROM `encode_jobs`;--> statement-breakpoint
DROP TABLE `encode_jobs`;--> statement-breakpoint
ALTER TABLE `__new_encode_jobs` RENAME TO `encode_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `encode_job_failure_reports_job_occurred_idx`;--> statement-breakpoint
CREATE INDEX `encode_job_failure_reports_job_sequence_idx` ON `encode_job_failure_reports` (`encode_job_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `encode_jobs_predecessor_unique` ON `encode_jobs` (`predecessor_encode_job_id`) WHERE "encode_jobs"."predecessor_encode_job_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `encode_jobs_initial_selection_profile_unique` ON `encode_jobs` (`disc_selection_id`,`encoding_profile_id`) WHERE "encode_jobs"."predecessor_encode_job_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `encode_jobs_output_path_unique` ON `encode_jobs` (`output_path`) WHERE "encode_jobs"."reserves_output_path" = 1;--> statement-breakpoint
CREATE INDEX `encode_jobs_queue_idx` ON `encode_jobs` (`status`,`priority`,`created_at`);
