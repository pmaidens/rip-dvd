UPDATE `original_disc_archives`
SET
	`catalog_reviewed_at` = NULL,
	`updated_at` = max(`updated_at`, unixepoch() * 1000)
WHERE `catalog_reviewed_at` IS NOT NULL
	AND (
		`disc_kind` <> 'dvd'
		OR EXISTS (
			SELECT 1
			FROM `disc_selections`
			WHERE `disc_selections`.`original_disc_archive_id` = `original_disc_archives`.`id`
				AND NOT (
					`disc_selections`.`kind` = 'main_feature'
					AND `disc_selections`.`source_key` = 'dvd:main-feature'
					AND `disc_selections`.`title_number` IS NULL
					AND `disc_selections`.`chapter_start` IS NULL
					AND `disc_selections`.`chapter_end` IS NULL
				)
		)
	);--> statement-breakpoint
UPDATE `encode_jobs`
SET
	`status` = 'failed',
	`error_message` = 'Encode Job requires catalog review after legacy Disc Selection validation',
	`updated_at` = max(`updated_at`, unixepoch() * 1000)
WHERE `status` IN ('queued', 'running')
	AND EXISTS (
		SELECT 1
		FROM `disc_selections`
		INNER JOIN `original_disc_archives`
			ON `original_disc_archives`.`id` = `disc_selections`.`original_disc_archive_id`
		WHERE `disc_selections`.`id` = `encode_jobs`.`disc_selection_id`
			AND `original_disc_archives`.`catalog_reviewed_at` IS NULL
	);
