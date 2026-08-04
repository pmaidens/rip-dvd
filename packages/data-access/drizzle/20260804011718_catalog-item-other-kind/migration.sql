PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_media_items` (
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
	CONSTRAINT "media_items_kind_check" CHECK("kind" in ('movie', 'tv_show', 'season', 'episode', 'trailer', 'bonus_feature', 'other')),
	CONSTRAINT "media_items_year_check" CHECK("year" is null or "year" between 1800 and 9999),
	CONSTRAINT "media_items_season_number_check" CHECK("season_number" is null or "season_number" >= 0),
	CONSTRAINT "media_items_episode_number_check" CHECK("episode_number" is null or "episode_number" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_media_items`(`id`, `parent_id`, `kind`, `title`, `year`, `season_number`, `episode_number`, `created_at`, `updated_at`) SELECT `id`, `parent_id`, `kind`, `title`, `year`, `season_number`, `episode_number`, `created_at`, `updated_at` FROM `media_items`;--> statement-breakpoint
DROP TABLE `media_items`;--> statement-breakpoint
ALTER TABLE `__new_media_items` RENAME TO `media_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `media_items_parent_idx` ON `media_items` (`parent_id`);
