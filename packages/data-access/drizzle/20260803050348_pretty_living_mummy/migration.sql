CREATE TABLE `original_disc_archive_content_ids` (
	`original_disc_archive_id` text PRIMARY KEY,
	`content_id` text NOT NULL,
	CONSTRAINT `fk_original_disc_archive_content_ids_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE CASCADE,
	CONSTRAINT "original_disc_archive_content_ids_id_not_null" CHECK("original_disc_archive_id" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archive_content_ids_content_id_unique` ON `original_disc_archive_content_ids` (`content_id`);