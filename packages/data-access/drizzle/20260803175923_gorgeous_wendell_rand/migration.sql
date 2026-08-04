ALTER TABLE `original_disc_archives` ADD `catalog_reviewed_at` integer;--> statement-breakpoint
UPDATE `original_disc_archives`
SET `catalog_reviewed_at` = (
	SELECT max(`updated_at`)
	FROM `disc_selections`
	WHERE `disc_selections`.`original_disc_archive_id` = `original_disc_archives`.`id`
)
WHERE EXISTS (
	SELECT 1
	FROM `disc_selections`
	WHERE `disc_selections`.`original_disc_archive_id` = `original_disc_archives`.`id`
);
