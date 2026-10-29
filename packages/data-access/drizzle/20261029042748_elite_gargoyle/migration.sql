CREATE TABLE `kept_failed_encode_outputs` (
	`id` text PRIMARY KEY,
	`artifact_identity` text NOT NULL,
	`failed_output_id` text NOT NULL,
	`record` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_kept_failed_encode_outputs_failed_output_id_validation_failed_encode_outputs_id_fk` FOREIGN KEY (`failed_output_id`) REFERENCES `validation_failed_encode_outputs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "kept_failed_outputs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "kept_failed_outputs_record_check" CHECK(json_valid("record") and json_extract("record", '$.id') is "id" and json_extract("record", '$.artifactIdentity') is "artifact_identity" and json_extract("record", '$.validationIdentity') is "failed_output_id")
);
--> statement-breakpoint
CREATE INDEX `kept_failed_outputs_artifact_index` ON `kept_failed_encode_outputs` (`artifact_identity`,`created_at`);