ALTER TABLE `disc_selections` ADD `is_catalog_active` integer DEFAULT true NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `disc_selections_archive_source_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `disc_selections_archive_active_source_unique` ON `disc_selections` (`original_disc_archive_id`,`source_key`) WHERE "disc_selections"."is_catalog_active" = 1;