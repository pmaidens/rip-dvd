CREATE TABLE `damage_previews` (
	`id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL,
	`status` text NOT NULL,
	`record` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_damage_previews_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "damage_previews_id_not_null" CHECK("id" is not null),
	CONSTRAINT "damage_previews_status_check" CHECK("status" in ('queued', 'waiting_for_checkpoint_or_ownership', 'generating', 'complete', 'failed', 'cancelled', 'interrupted', 'partial')),
	CONSTRAINT "damage_previews_record_check" CHECK(json_valid("record") and json_extract("record", '$.id') = "id" and json_extract("record", '$.status') = "status")
);
--> statement-breakpoint
CREATE INDEX `damage_previews_queue_idx` ON `damage_previews` (`status`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER `damage_previews_provenance_immutable`
BEFORE UPDATE ON `damage_previews`
WHEN NEW.`id` <> OLD.`id`
  OR NEW.`original_disc_archive_id` <> OLD.`original_disc_archive_id`
  OR NEW.`created_at` <> OLD.`created_at`
  OR json_extract(NEW.`record`, '$.preflightToken') IS NOT json_extract(OLD.`record`, '$.preflightToken')
  OR json_extract(NEW.`record`, '$.selectionJson') IS NOT json_extract(OLD.`record`, '$.selectionJson')
  OR json_extract(NEW.`record`, '$.reviewJson') IS NOT json_extract(OLD.`record`, '$.reviewJson')
  OR json_extract(NEW.`record`, '$.createdAt') IS NOT json_extract(OLD.`record`, '$.createdAt')
BEGIN SELECT RAISE(ABORT, 'Damage Preview request provenance is immutable'); END;
