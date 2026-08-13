CREATE TABLE `corrected_encode_publication_authorities` (
	`replacement_encode_job_id` text PRIMARY KEY,
	`claim_token` text NOT NULL,
	`retained_output_path` text NOT NULL,
	`filesystem_identity` text NOT NULL,
	CONSTRAINT `fk_corrected_encode_publication_authorities_replacement_encode_job_id_encode_jobs_id_fk` FOREIGN KEY (`replacement_encode_job_id`) REFERENCES `encode_jobs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "corrected_encode_publication_authorities_id_not_null" CHECK("replacement_encode_job_id" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `corrected_encode_publication_authorities_path_unique` ON `corrected_encode_publication_authorities` (`retained_output_path`);
