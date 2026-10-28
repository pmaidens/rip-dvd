CREATE TABLE `encode_output_inspection_receipts` (
	`id` text PRIMARY KEY,
	`encode_job_id` text NOT NULL,
	`generation_identity` text NOT NULL,
	`record` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "encode_output_inspection_receipts_id_not_null" CHECK("id" is not null),
	CONSTRAINT "encode_output_inspection_receipts_record_check" CHECK(json_valid("record") and json_extract("record", '$.id') = "id" and json_extract("record", '$.encodeJobId') = "encode_job_id" and json_extract("record", '$.generationIdentity') = "generation_identity")
);
--> statement-breakpoint
CREATE INDEX `encode_output_inspection_receipts_job_idx` ON `encode_output_inspection_receipts` (`encode_job_id`,`created_at`);
