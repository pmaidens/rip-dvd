CREATE TABLE `archive_jobs` (
	`id` text PRIMARY KEY,
	`detected_disc_id` text NOT NULL,
	`original_disc_archive_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`progress_percent` integer DEFAULT 0 NOT NULL,
	`claimed_by` text,
	`claim_token` text,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_archive_jobs_detected_disc_id_detected_discs_id_fk` FOREIGN KEY (`detected_disc_id`) REFERENCES `detected_discs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_archive_jobs_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "archive_jobs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "archive_jobs_status_check" CHECK("status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "archive_jobs_progress_check" CHECK("progress_percent" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE `detected_discs` (
	`id` text PRIMARY KEY,
	`optical_drive_id` text NOT NULL,
	`disc_kind` text NOT NULL,
	`fingerprint` text NOT NULL,
	`volume_label` text,
	`status` text DEFAULT 'detected' NOT NULL,
	`scan_data` text,
	`detected_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_detected_discs_optical_drive_id_optical_drives_id_fk` FOREIGN KEY (`optical_drive_id`) REFERENCES `optical_drives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "detected_discs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "detected_discs_kind_check" CHECK("disc_kind" in ('dvd', 'blu_ray', 'audio_cd')),
	CONSTRAINT "detected_discs_status_check" CHECK("status" in ('detected', 'scanned', 'approved', 'archived', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE `disc_selections` (
	`id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL,
	`media_item_id` text NOT NULL,
	`source_key` text NOT NULL,
	`kind` text NOT NULL,
	`title_number` integer,
	`chapter_start` integer,
	`chapter_end` integer,
	`label` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_disc_selections_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_disc_selections_media_item_id_media_items_id_fk` FOREIGN KEY (`media_item_id`) REFERENCES `media_items`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "disc_selections_id_not_null" CHECK("id" is not null),
	CONSTRAINT "disc_selections_kind_check" CHECK("kind" in ('main_feature', 'dvd_title', 'dvd_chapters')),
	CONSTRAINT "disc_selections_shape_check" CHECK(("kind" = 'main_feature' and "title_number" is null and "chapter_start" is null and "chapter_end" is null) or ("kind" = 'dvd_title' and typeof("title_number") = 'integer' and "title_number" > 0 and "chapter_start" is null and "chapter_end" is null) or ("kind" = 'dvd_chapters' and typeof("title_number") = 'integer' and "title_number" > 0 and typeof("chapter_start") = 'integer' and "chapter_start" > 0 and typeof("chapter_end") = 'integer' and "chapter_end" >= "chapter_start"))
);
--> statement-breakpoint
CREATE TABLE `encode_jobs` (
	`id` text PRIMARY KEY,
	`disc_selection_id` text NOT NULL,
	`encoding_profile_id` text NOT NULL,
	`output_path` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`progress_percent` integer DEFAULT 0 NOT NULL,
	`claimed_by` text,
	`claim_token` text,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_encode_jobs_disc_selection_id_disc_selections_id_fk` FOREIGN KEY (`disc_selection_id`) REFERENCES `disc_selections`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_encode_jobs_encoding_profile_id_encoding_profiles_id_fk` FOREIGN KEY (`encoding_profile_id`) REFERENCES `encoding_profiles`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "encode_jobs_id_not_null" CHECK("id" is not null),
	CONSTRAINT "encode_jobs_status_check" CHECK("status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "encode_jobs_progress_check" CHECK("progress_percent" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE `encoding_profiles` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL,
	`display_name` text NOT NULL,
	`media_domain` text NOT NULL,
	`version` integer NOT NULL,
	`settings` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "encoding_profiles_id_not_null" CHECK("id" is not null),
	CONSTRAINT "encoding_profiles_domain_check" CHECK("media_domain" in ('dvd_video', 'audio')),
	CONSTRAINT "encoding_profiles_version_check" CHECK(typeof("version") = 'integer' and "version" > 0)
);
--> statement-breakpoint
CREATE TABLE `media_items` (
	`id` text PRIMARY KEY,
	`parent_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`year` integer,
	`season_number` integer,
	`episode_number` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_media_items_parent_id_media_items_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `media_items`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "media_items_id_not_null" CHECK("id" is not null),
	CONSTRAINT "media_items_kind_check" CHECK("kind" in ('movie', 'tv_show', 'season', 'episode', 'trailer', 'bonus_feature')),
	CONSTRAINT "media_items_year_check" CHECK("year" is null or "year" between 1800 and 9999),
	CONSTRAINT "media_items_season_number_check" CHECK("season_number" is null or "season_number" >= 0),
	CONSTRAINT "media_items_episode_number_check" CHECK("episode_number" is null or "episode_number" > 0)
);
--> statement-breakpoint
CREATE TABLE `optical_drives` (
	`id` text PRIMARY KEY,
	`device_path` text NOT NULL,
	`display_name` text,
	`vendor` text,
	`product` text,
	`serial_number` text,
	`is_enabled` integer DEFAULT false NOT NULL,
	`is_present` integer DEFAULT true NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "optical_drives_id_not_null" CHECK("id" is not null)
);
--> statement-breakpoint
CREATE TABLE `original_disc_archives` (
	`id` text PRIMARY KEY,
	`detected_disc_id` text NOT NULL,
	`disc_kind` text NOT NULL,
	`archive_format` text NOT NULL,
	`archive_path` text NOT NULL,
	`fingerprint` text NOT NULL,
	`size_bytes` integer,
	`archived_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_original_disc_archives_detected_disc_id_detected_discs_id_fk` FOREIGN KEY (`detected_disc_id`) REFERENCES `detected_discs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "original_disc_archives_id_not_null" CHECK("id" is not null),
	CONSTRAINT "original_disc_archives_kind_check" CHECK("disc_kind" in ('dvd', 'blu_ray', 'audio_cd')),
	CONSTRAINT "original_disc_archives_format_check" CHECK("archive_format" in ('iso')),
	CONSTRAINT "original_disc_archives_size_check" CHECK("size_bytes" is null or "size_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `archive_jobs_detected_disc_unique` ON `archive_jobs` (`detected_disc_id`);--> statement-breakpoint
CREATE INDEX `archive_jobs_queue_idx` ON `archive_jobs` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `detected_discs_drive_fingerprint_unique` ON `detected_discs` (`optical_drive_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `detected_discs_status_idx` ON `detected_discs` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `disc_selections_archive_source_unique` ON `disc_selections` (`original_disc_archive_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `disc_selections_media_item_idx` ON `disc_selections` (`media_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `encode_jobs_selection_profile_unique` ON `encode_jobs` (`disc_selection_id`,`encoding_profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `encode_jobs_output_path_unique` ON `encode_jobs` (`output_path`);--> statement-breakpoint
CREATE INDEX `encode_jobs_queue_idx` ON `encode_jobs` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `encoding_profiles_domain_key_version_unique` ON `encoding_profiles` (`media_domain`,`key`,`version`);--> statement-breakpoint
CREATE INDEX `media_items_parent_idx` ON `media_items` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `optical_drives_device_path_unique` ON `optical_drives` (`device_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_detected_disc_unique` ON `original_disc_archives` (`detected_disc_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_path_unique` ON `original_disc_archives` (`archive_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `original_disc_archives_fingerprint_unique` ON `original_disc_archives` (`fingerprint`);
