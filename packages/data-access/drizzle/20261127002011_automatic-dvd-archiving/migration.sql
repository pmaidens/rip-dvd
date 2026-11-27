CREATE TABLE `archiving_settings` (
	`id` integer PRIMARY KEY,
	`automatically_archive_inserted_dvds` integer NOT NULL,
	CONSTRAINT "archiving_settings_id_not_null" CHECK("id" is not null),
	CONSTRAINT "archiving_settings_singleton" CHECK("id" = 1),
	CONSTRAINT "archiving_settings_automatic_dvds_boolean" CHECK("automatically_archive_inserted_dvds" in (0, 1))
);
--> statement-breakpoint
ALTER TABLE `archive_requests` ADD `origin` text;--> statement-breakpoint
CREATE INDEX `archive_requests_cancelled_disc_updated_idx` ON `archive_requests` (`detected_disc_id`,`updated_at`,`id`) WHERE "archive_requests"."status" = 'cancelled';--> statement-breakpoint
CREATE INDEX `detected_discs_fingerprint_idx` ON `detected_discs` (`fingerprint`);