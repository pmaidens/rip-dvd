CREATE TABLE `encode_claim_snapshots` (
	`id` text PRIMARY KEY,
	`encode_job_id` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_encode_claim_snapshots_encode_job_id_encode_jobs_id_fk` FOREIGN KEY (`encode_job_id`) REFERENCES `encode_jobs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "encode_claim_snapshots_id_not_null" CHECK("id" is not null),
	CONSTRAINT "encode_claim_snapshots_source_check" CHECK(json_valid("source") and json_type("source", '$.schemaVersion') is 'integer' and json_extract("source", '$.schemaVersion') is 1)
);
--> statement-breakpoint
ALTER TABLE `encode_jobs` ADD `expected_source_decision` text;--> statement-breakpoint
CREATE INDEX `encode_claim_snapshots_job_index` ON `encode_claim_snapshots` (`encode_job_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER encode_claim_snapshots_immutable_update BEFORE UPDATE ON encode_claim_snapshots
BEGIN SELECT RAISE(ABORT, 'Encode claim snapshots are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER encode_claim_snapshots_immutable_delete BEFORE DELETE ON encode_claim_snapshots
BEGIN SELECT RAISE(ABORT, 'Encode claim snapshots are immutable'); END;
