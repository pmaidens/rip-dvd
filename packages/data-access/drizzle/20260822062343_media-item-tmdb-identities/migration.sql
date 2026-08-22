CREATE TABLE `media_item_tmdb_identities` (
	`media_item_id` text PRIMARY KEY,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_media_item_tmdb_identities_media_item_id_media_items_id_fk` FOREIGN KEY (`media_item_id`) REFERENCES `media_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT "media_item_tmdb_identities_id_not_null" CHECK("media_item_id" is not null),
	CONSTRAINT "media_item_tmdb_identities_type_check" CHECK("media_type" in ('movie', 'tv_show')),
	CONSTRAINT "media_item_tmdb_identities_id_check" CHECK(typeof("tmdb_id") = 'integer' and "tmdb_id" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_item_tmdb_identities_identity_unique` ON `media_item_tmdb_identities` (`media_type`,`tmdb_id`);
