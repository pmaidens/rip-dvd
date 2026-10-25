ALTER TABLE `archive_recovery_work` ADD `pass_started_manifest_revision` integer;--> statement-breakpoint
CREATE INDEX `dvd_archive_recovery_reads_archive_revision_idx` ON `dvd_archive_recovery_reads` (`original_disc_archive_id`,`from_manifest_revision`);
