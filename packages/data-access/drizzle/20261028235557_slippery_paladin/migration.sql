CREATE TABLE `validation_failed_encode_outputs` (
	`id` text PRIMARY KEY,
	`encode_job_id` text NOT NULL,
	`claim_token` text NOT NULL,
	`output_path` text NOT NULL,
	`change_time_ms` real NOT NULL,
	`filesystem_identity` text NOT NULL,
	`validated_at` integer NOT NULL,
	`source_snapshot` text,
	`failure` text NOT NULL,
	CONSTRAINT `fk_validation_failed_encode_outputs_encode_job_id_encode_jobs_id_fk` FOREIGN KEY (`encode_job_id`) REFERENCES `encode_jobs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "validation_failed_outputs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "validation_failed_outputs_failure_check" CHECK(json_valid("failure") and json_extract("failure", '$.reasonCode') is 'output_validation_failed' and json_extract("failure", '$.phase') is 'validation'),
	CONSTRAINT "validation_failed_outputs_source_check" CHECK("source_snapshot" is null or (json_valid("source_snapshot") and json_extract("source_snapshot", '$.id') is "claim_token" and json_extract("source_snapshot", '$.encodeJobId') is "encode_job_id" and json_extract("source_snapshot", '$.source.schemaVersion') is 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `validation_failed_outputs_claim_unique` ON `validation_failed_encode_outputs` (`encode_job_id`,`claim_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `validation_failed_outputs_path_unique` ON `validation_failed_encode_outputs` (`output_path`);--> statement-breakpoint
CREATE INDEX `validation_failed_outputs_job_index` ON `validation_failed_encode_outputs` (`encode_job_id`,`validated_at`,`id`);