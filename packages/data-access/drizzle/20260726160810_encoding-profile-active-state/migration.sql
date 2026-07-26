ALTER TABLE `encoding_profiles` ADD `is_active` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `encoding_profiles`
SET `is_active` = true
WHERE (`media_domain`, `key`, `version`) IN (
	SELECT `media_domain`, `key`, MAX(`version`)
	FROM `encoding_profiles`
	GROUP BY `media_domain`, `key`
);--> statement-breakpoint
CREATE UNIQUE INDEX `encoding_profiles_one_active_version_unique` ON `encoding_profiles` (`media_domain`,`key`) WHERE "encoding_profiles"."is_active" = 1;
