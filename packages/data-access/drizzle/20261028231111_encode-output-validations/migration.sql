CREATE TABLE `encode_output_validations` (
	`id` text PRIMARY KEY,
	`encode_job_id` text NOT NULL,
	`claim_token` text NOT NULL,
	`filesystem_identity` text NOT NULL,
	`validated_at` integer NOT NULL,
	`source_snapshot` text,
	`evidence` text,
	CONSTRAINT `fk_encode_output_validations_encode_job_id_encode_jobs_id_fk` FOREIGN KEY (`encode_job_id`) REFERENCES `encode_jobs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "encode_output_validations_id_not_null" CHECK("id" is not null),
	CONSTRAINT "encode_output_validations_source_check" CHECK("source_snapshot" is null or (json_valid("source_snapshot") and json_extract("source_snapshot", '$.id') = "claim_token" and json_extract("source_snapshot", '$.encodeJobId') = "encode_job_id" and json_extract("source_snapshot", '$.source.schemaVersion') = 1)),
	CONSTRAINT "encode_output_validations_evidence_check" CHECK("evidence" is null or (json_valid("evidence") and json_extract("evidence", '$.policyVersion') = 'encode-output-validation-v1'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `encode_output_validations_claim_unique` ON `encode_output_validations` (`encode_job_id`,`claim_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `encode_output_validations_generation_unique` ON `encode_output_validations` (`encode_job_id`,`filesystem_identity`,`validated_at`);
--> statement-breakpoint
CREATE TRIGGER encode_output_validations_immutable_update BEFORE UPDATE ON encode_output_validations
BEGIN SELECT RAISE(ABORT, 'Encode output validations are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER encode_output_validations_immutable_delete BEFORE DELETE ON encode_output_validations
BEGIN SELECT RAISE(ABORT, 'Encode output validations are immutable'); END;
