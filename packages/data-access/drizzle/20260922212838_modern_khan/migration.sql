CREATE TABLE `rearchive_mapping_proposals` (
	`target_archive_id` text PRIMARY KEY,
	`source_archive_id` text NOT NULL,
	`source_catalog_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_rearchive_mapping_proposals_target_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`target_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_rearchive_mapping_proposals_source_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`source_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "rearchive_mapping_proposals_distinct_archives_check" CHECK("target_archive_id" <> "source_archive_id")
);
--> statement-breakpoint
CREATE TABLE `rearchive_mapping_proposal_items` (
	`target_archive_id` text NOT NULL,
	`source_disc_selection_id` text NOT NULL,
	`media_item_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`title_number` integer,
	`chapter_start` integer,
	`chapter_end` integer,
	`label` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `rearchive_mapping_proposal_items_pk` PRIMARY KEY(`target_archive_id`, `source_disc_selection_id`),
	CONSTRAINT `fk_rearchive_mapping_proposal_items_target_archive_id_rearchive_mapping_proposals_target_archive_id_fk` FOREIGN KEY (`target_archive_id`) REFERENCES `rearchive_mapping_proposals`(`target_archive_id`) ON DELETE CASCADE,
	CONSTRAINT "rearchive_mapping_proposal_items_ordinal_check" CHECK(typeof("ordinal") = 'integer' and "ordinal" >= 0),
	CONSTRAINT "rearchive_mapping_proposal_items_kind_check" CHECK("kind" in ('main_feature', 'dvd_title', 'dvd_chapters')),
	CONSTRAINT "rearchive_mapping_proposal_items_shape_check" CHECK(("kind" = 'main_feature' and "title_number" is null and "chapter_start" is null and "chapter_end" is null) or ("kind" = 'dvd_title' and typeof("title_number") = 'integer' and "title_number" > 0 and "chapter_start" is null and "chapter_end" is null) or ("kind" = 'dvd_chapters' and typeof("title_number") = 'integer' and "title_number" > 0 and typeof("chapter_start") = 'integer' and "chapter_start" > 0 and typeof("chapter_end") = 'integer' and "chapter_end" >= "chapter_start"))
);
--> statement-breakpoint
CREATE INDEX `rearchive_mapping_proposals_source_idx` ON `rearchive_mapping_proposals` (`source_archive_id`,`updated_at`,`target_archive_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `rearchive_mapping_proposal_items_ordinal_unique` ON `rearchive_mapping_proposal_items` (`target_archive_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `rearchive_mapping_proposal_items_media_item_idx` ON `rearchive_mapping_proposal_items` (`media_item_id`);
