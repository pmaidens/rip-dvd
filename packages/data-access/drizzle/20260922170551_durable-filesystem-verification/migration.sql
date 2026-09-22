CREATE TABLE `filesystem_verification_runs` (
	`id` text PRIMARY KEY,
	`target` text NOT NULL,
	`target_id` text NOT NULL,
	`status` text NOT NULL,
	`progress_phase` text NOT NULL,
	`result_status` text,
	`result_message` text,
	`verified_at` integer,
	`failure_code` text,
	`claim_token` text,
	`claimed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "filesystem_verification_runs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "filesystem_verification_runs_target_check" CHECK("target" in ('original_disc_archive', 'encode_job_output')),
	CONSTRAINT "filesystem_verification_runs_status_check" CHECK("status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "filesystem_verification_runs_phase_check" CHECK("progress_phase" in ('queued', 'checking', 'completed')),
	CONSTRAINT "filesystem_verification_runs_claim_check" CHECK(("claim_token" is null) = ("claimed_at" is null)),
	CONSTRAINT "filesystem_verification_runs_result_check" CHECK(("result_status" is null) = ("result_message" is null) and
          ("result_status" is null) = ("verified_at" is null)),
	CONSTRAINT "filesystem_verification_runs_result_status_check" CHECK("result_status" is null or "result_status" in ('accessible', 'missing', 'inaccessible', 'error')),
	CONSTRAINT "filesystem_verification_runs_state_check" CHECK(("status" = 'queued' and "progress_phase" = 'queued' and
            "claim_token" is null and "result_status" is null and "failure_code" is null) or
          ("status" = 'running' and "progress_phase" = 'checking' and
            "claim_token" is not null and "result_status" is null and "failure_code" is null) or
          ("status" = 'completed' and "progress_phase" = 'completed' and
            "claim_token" is null and "result_status" is not null and "failure_code" is null) or
          ("status" = 'failed' and "progress_phase" = 'completed' and
            "claim_token" is null and "result_status" is null and "failure_code" is not null))
);
--> statement-breakpoint
CREATE INDEX `filesystem_verification_runs_status_created_idx` ON `filesystem_verification_runs` (`status`,`created_at`,`id`);