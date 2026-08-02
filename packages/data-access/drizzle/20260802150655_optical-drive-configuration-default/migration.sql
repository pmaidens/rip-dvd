ALTER TABLE `optical_drives` ADD `configuration_default_applied` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `optical_drives` ADD `is_configured_target` integer DEFAULT false NOT NULL;
