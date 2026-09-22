CREATE INDEX `archive_jobs_inspection_created_idx` ON `archive_jobs` (`disc_inspection_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `archive_jobs_archive_created_idx` ON `archive_jobs` (`original_disc_archive_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `archive_jobs_disc_created_idx` ON `archive_jobs` (`detected_disc_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `archive_requests_disc_created_idx` ON `archive_requests` (`detected_disc_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `disc_inspections_drive_updated_idx` ON `disc_inspections` (`optical_drive_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `disc_inspections_disc_updated_idx` ON `disc_inspections` (`detected_disc_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `encode_jobs_selection_created_idx` ON `encode_jobs` (`disc_selection_id`,`created_at`,`id`);