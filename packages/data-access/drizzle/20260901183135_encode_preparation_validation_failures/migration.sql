ALTER TABLE `encode_job_failure_reports` ADD `validation_check` text;--> statement-breakpoint
ALTER TABLE `encode_job_failure_reports` ADD `expected_seconds` real;--> statement-breakpoint
ALTER TABLE `encode_job_failure_reports` ADD `observed_seconds` real;--> statement-breakpoint
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
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_encode_job_failure_reports_encode_job_id_encode_jobs_id_fk` FOREIGN KEY (`encode_job_id`) REFERENCES `encode_jobs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "encode_job_failure_reports_id_not_null" CHECK("id" is not null),
	CONSTRAINT "encode_job_failure_reports_schema_version_check" CHECK("schema_version" in (1)),
	CONSTRAINT "encode_job_failure_reports_worker_kind_check" CHECK("worker_kind" = 'encode_worker'),
	CONSTRAINT "encode_job_failure_reports_reason_code_check" CHECK("reason_code" in ('input_unavailable', 'invalid_configuration', 'output_conflict', 'unsafe_output_state', 'command_failed', 'command_timeout', 'output_validation_failed', 'unknown_failure')),
	CONSTRAINT "encode_job_failure_reports_phase_check" CHECK("phase" in ('preparation', 'scanning', 'previewing', 'encoding', 'validation', 'cleanup', 'publication', 'recovery')),
	CONSTRAINT "encode_job_failure_reports_retryability_check" CHECK("retryability" in ('appropriate', 'after_action', 'not_appropriate')),
	CONSTRAINT "encode_job_failure_reports_diagnostic_check" CHECK("diagnostic" is null or (typeof("diagnostic") = 'text' and length("diagnostic") between 1 and 500)),
	CONSTRAINT "encode_job_failure_reports_evidence_check" CHECK(("reason_code" = 'command_failed' and "timeout_seconds" is null and "validation_check" is null and "expected_seconds" is null and "observed_seconds" is null and ((typeof("exit_status") = 'integer' and "exit_status" between 1 and 255 and "signal" is null) or ("exit_status" is null and "signal" in ('SIGABRT', 'SIGALRM', 'SIGBREAK', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGIO', 'SIGIOT', 'SIGKILL', 'SIGLOST', 'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT', 'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGUNUSED', 'SIGURG', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ', 'SIGINFO')))) or ("reason_code" = 'command_timeout' and "exit_status" is null and "signal" is null and typeof("timeout_seconds") = 'integer' and "timeout_seconds" between 1 and 604800 and "validation_check" is null and "expected_seconds" is null and "observed_seconds" is null) or ("reason_code" = 'output_validation_failed' and "exit_status" is null and "signal" is null and "timeout_seconds" is null and (("validation_check" in ('subtitle_streams', 'subtitle_packets', 'subtitle_cleanup', 'video_metadata', 'duration_metadata', 'video_packets', 'audio_timing', 'video_decode', 'output_file') and "expected_seconds" is null and "observed_seconds" is null) or ("validation_check" is null and typeof("expected_seconds") in ('integer', 'real') and "expected_seconds" > 0 and "expected_seconds" <= 604800 and typeof("observed_seconds") in ('integer', 'real') and "observed_seconds" >= 0 and "observed_seconds" <= 604800))) or ("reason_code" in ('input_unavailable', 'invalid_configuration', 'output_conflict', 'unsafe_output_state', 'unknown_failure') and "exit_status" is null and "signal" is null and "timeout_seconds" is null and "validation_check" is null and "expected_seconds" is null and "observed_seconds" is null))
);
--> statement-breakpoint
INSERT INTO `__new_encode_job_failure_reports`(`id`, `encode_job_id`, `schema_version`, `worker_kind`, `reason_code`, `phase`, `retryability`, `diagnostic`, `exit_status`, `signal`, `timeout_seconds`, `occurred_at`, `created_at`) SELECT `id`, `encode_job_id`, `schema_version`, `worker_kind`, `reason_code`, `phase`, `retryability`, `diagnostic`, `exit_status`, `signal`, `timeout_seconds`, `occurred_at`, `created_at` FROM `encode_job_failure_reports`;--> statement-breakpoint
DROP TABLE `encode_job_failure_reports`;--> statement-breakpoint
ALTER TABLE `__new_encode_job_failure_reports` RENAME TO `encode_job_failure_reports`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `encode_job_failure_reports_job_occurred_idx` ON `encode_job_failure_reports` (`encode_job_id`,`occurred_at`,`id`);