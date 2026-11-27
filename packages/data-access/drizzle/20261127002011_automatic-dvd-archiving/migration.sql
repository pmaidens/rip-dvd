CREATE TABLE `archiving_settings` (
	`id` integer PRIMARY KEY,
	`automatically_archive_inserted_dvds` integer NOT NULL,
	CONSTRAINT "archiving_settings_singleton" CHECK("id" = 1),
	CONSTRAINT "archiving_settings_automatic_dvds_boolean" CHECK("automatically_archive_inserted_dvds" in (0, 1))
);
--> statement-breakpoint
ALTER TABLE `archive_requests` ADD `origin` text;