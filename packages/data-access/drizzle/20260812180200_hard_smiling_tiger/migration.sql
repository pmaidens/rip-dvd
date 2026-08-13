CREATE TABLE `disc_selection_supersessions` (
	`superseded_disc_selection_id` text PRIMARY KEY,
	`replacement_disc_selection_id` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_disc_selection_supersessions_superseded_disc_selection_id_disc_selections_id_fk` FOREIGN KEY (`superseded_disc_selection_id`) REFERENCES `disc_selections`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_disc_selection_supersessions_replacement_disc_selection_id_disc_selections_id_fk` FOREIGN KEY (`replacement_disc_selection_id`) REFERENCES `disc_selections`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "disc_selection_supersessions_id_not_null" CHECK("superseded_disc_selection_id" is not null),
	CONSTRAINT "disc_selection_supersessions_distinct_selections_check" CHECK("superseded_disc_selection_id" <> "replacement_disc_selection_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `disc_selection_supersessions_replacement_unique` ON `disc_selection_supersessions` (`replacement_disc_selection_id`);
