CREATE TABLE `archive_audit_findings` (
	`archive_audit_run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`finding` text NOT NULL,
	CONSTRAINT `archive_audit_findings_pk` PRIMARY KEY(`archive_audit_run_id`, `sequence`),
	CONSTRAINT `fk_archive_audit_findings_archive_audit_run_id_archive_audit_runs_id_fk` FOREIGN KEY (`archive_audit_run_id`) REFERENCES `archive_audit_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "archive_audit_findings_sequence_check" CHECK("sequence" >= 0),
	CONSTRAINT "archive_audit_findings_json_check" CHECK(json_valid("finding") and json_type("finding") = 'object')
);
--> statement-breakpoint
CREATE TABLE `archive_audit_runs` (
	`id` text PRIMARY KEY,
	`status` text NOT NULL,
	`progress_phase` text NOT NULL,
	`record_limit` integer NOT NULL,
	`concurrency` integer NOT NULL,
	`file_timeout_ms` integer NOT NULL,
	`runtime_timeout_ms` integer NOT NULL,
	`record_count` integer,
	`records_processed` integer NOT NULL,
	`truncated` integer,
	`result_status` text,
	`incomplete_reason` text,
	`failure_code` text,
	`claim_token` text,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "archive_audit_runs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "archive_audit_runs_status_check" CHECK("status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "archive_audit_runs_phase_check" CHECK("progress_phase" in ('queued', 'reading_records', 'auditing', 'completed')),
	CONSTRAINT "archive_audit_runs_bounds_check" CHECK("record_limit" between 1 and 1000 and "concurrency" between 1 and 8 and "file_timeout_ms" between 1 and 30000 and "runtime_timeout_ms" between 1 and 600000),
	CONSTRAINT "archive_audit_runs_progress_check" CHECK("records_processed" >= 0 and ("record_count" is null or ("record_count" >= 0 and "records_processed" <= "record_count"))),
	CONSTRAINT "archive_audit_runs_claim_check" CHECK(("claim_token" is null) = ("claimed_at" is null)),
	CONSTRAINT "archive_audit_runs_result_check" CHECK("result_status" is null or "result_status" in ('complete', 'incomplete')),
	CONSTRAINT "archive_audit_runs_incomplete_check" CHECK(("result_status" = 'incomplete') = ("incomplete_reason" is not null) and ("incomplete_reason" is null or "incomplete_reason" = 'runtime_timeout')),
	CONSTRAINT "archive_audit_runs_state_check" CHECK(
      ("status" = 'queued' and "progress_phase" = 'queued' and
        "claim_token" is null and "record_count" is null and
        "records_processed" = 0 and "truncated" is null and
        "result_status" is null and "failure_code" is null and
        "started_at" is null and "completed_at" is null) or
      ("status" = 'running' and "progress_phase" in ('reading_records', 'auditing') and
        "claim_token" is not null and "result_status" is null and
        "failure_code" is null and "started_at" is not null and
        "completed_at" is null and
        (("progress_phase" = 'reading_records' and "record_count" is null and "truncated" is null) or
         ("progress_phase" = 'auditing' and "record_count" is not null and "truncated" is not null))) or
      ("status" = 'completed' and "progress_phase" = 'completed' and
        "claim_token" is null and "result_status" is not null and
        "failure_code" is null and "started_at" is not null and "completed_at" is not null) or
      ("status" = 'failed' and "progress_phase" = 'completed' and
        "claim_token" is null and "result_status" is null and
        "failure_code" is not null and "started_at" is not null and "completed_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `archive_audit_runs_status_created_idx` ON `archive_audit_runs` (`status`,`created_at`,`id`);