DROP TRIGGER IF EXISTS `dvd_evidence_incomplete_archive_insert_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_incomplete_archive_update_guard`;--> statement-breakpoint
ALTER TABLE `dvd_archive_evidence_headers` ADD `accepted_end_lba_exclusive` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `dvd_archive_evidence_headers` ADD `unrecovered_source_ranges` text NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_dvd_archive_evidence_headers` (
	`original_disc_archive_id` text PRIMARY KEY,
	`source_archive_job_id` text NOT NULL,
	`evidence_format` text NOT NULL,
	`accepted_end_lba_exclusive` integer NOT NULL,
	`unrecovered_source_ranges` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_archive_evidence_headers_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_archive_evidence_headers_source_archive_job_id_archive_jobs_id_fk` FOREIGN KEY (`source_archive_job_id`) REFERENCES `archive_jobs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_archive_evidence_headers_archive_id_not_null" CHECK("original_disc_archive_id" is not null),
	CONSTRAINT "dvd_archive_evidence_headers_format_check" CHECK("evidence_format" in ('dvd-recovery-evidence-v1')),
	CONSTRAINT "dvd_archive_evidence_headers_extent_check" CHECK(typeof("accepted_end_lba_exclusive") = 'integer' and "accepted_end_lba_exclusive" > 0),
	CONSTRAINT "dvd_archive_evidence_headers_source_ranges_check" CHECK(json_valid("unrecovered_source_ranges") and json_type("unrecovered_source_ranges") = 'array')
);
--> statement-breakpoint
INSERT INTO `__new_dvd_archive_evidence_headers`(`original_disc_archive_id`, `source_archive_job_id`, `evidence_format`, `created_at`) SELECT `original_disc_archive_id`, `source_archive_job_id`, `evidence_format`, `created_at` FROM `dvd_archive_evidence_headers`;--> statement-breakpoint
DROP TABLE `dvd_archive_evidence_headers`;--> statement-breakpoint
ALTER TABLE `__new_dvd_archive_evidence_headers` RENAME TO `dvd_archive_evidence_headers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_archive_evidence_headers_job_unique` ON `dvd_archive_evidence_headers` (`source_archive_job_id`);--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_header_insert_provenance`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_header_update_provenance`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_header_delete_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_incomplete_archive_insert_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_incomplete_archive_update_guard`;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_header_insert_guard`
BEFORE INSERT ON `dvd_archive_evidence_headers`
BEGIN
  SELECT CASE WHEN
    typeof(NEW.`accepted_end_lba_exclusive`) <> 'integer'
    OR NEW.`accepted_end_lba_exclusive` NOT BETWEEN 1 AND 9007199254740991
    OR NOT json_valid(NEW.`unrecovered_source_ranges`)
    OR json_type(NEW.`unrecovered_source_ranges`) <> 'array'
  THEN RAISE(
    ABORT,
    'DVD evidence header has invalid accepted extent or source ranges'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.`unrecovered_source_ranges`) AS source_range
    WHERE json_type(source_range.`value`) IS NOT 'object'
      OR (SELECT count(*) FROM json_each(source_range.`value`)) <> 3
      OR json_type(source_range.`value`, '$.startLba') IS NOT 'integer'
      OR json_extract(source_range.`value`, '$.startLba') NOT BETWEEN 0 AND 9007199254740991
      OR json_type(source_range.`value`, '$.sectorCount') IS NOT 'integer'
      OR json_extract(source_range.`value`, '$.sectorCount') NOT BETWEEN 1 AND 9007199254740991
      OR json_type(source_range.`value`, '$.classification') IS NOT 'text'
      OR json_extract(source_range.`value`, '$.classification') NOT IN (
        'skipped_untested',
        'individually_failed'
      )
      OR json_extract(source_range.`value`, '$.startLba')
        + json_extract(source_range.`value`, '$.sectorCount')
        > NEW.`accepted_end_lba_exclusive`
  ) THEN RAISE(
    ABORT,
    'DVD evidence header source ranges must be valid and inside the accepted extent'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.`unrecovered_source_ranges`) AS current_range
    INNER JOIN json_each(NEW.`unrecovered_source_ranges`) AS previous_range
      ON CAST(previous_range.`key` AS integer)
        = CAST(current_range.`key` AS integer) - 1
    WHERE json_extract(current_range.`value`, '$.startLba')
      < json_extract(previous_range.`value`, '$.startLba')
        + json_extract(previous_range.`value`, '$.sectorCount')
  ) THEN RAISE(
    ABORT,
    'DVD evidence header source ranges must be normalized'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM `archive_jobs` AS source_job
    INNER JOIN `archive_requests` AS source_request
      ON source_request.`id` = source_job.`archive_request_id`
    INNER JOIN `disc_inspections` AS source_inspection
      ON source_inspection.`id` = source_job.`disc_inspection_id`
    INNER JOIN `original_disc_archives` AS source_archive
      ON source_archive.`id` = NEW.`original_disc_archive_id`
    WHERE source_job.`id` = NEW.`source_archive_job_id`
      AND source_job.`original_disc_archive_id`
        = NEW.`original_disc_archive_id`
      AND source_job.`evidence_format` = NEW.`evidence_format`
      AND source_job.`status` = 'completed'
      AND source_job.`detected_disc_id` = source_archive.`detected_disc_id`
      AND source_request.`detected_disc_id`
        = source_archive.`detected_disc_id`
      AND source_request.`evidence_format` = NEW.`evidence_format`
      AND source_request.`status` = 'fulfilled'
      AND source_inspection.`detected_disc_id`
        = source_archive.`detected_disc_id`
      AND source_inspection.`status` = 'completed'
      AND source_archive.`disc_kind` = 'dvd'
      AND source_archive.`boundary_policy_version` IS NOT NULL
      AND source_archive.`boundary_published_size_bytes`
        = source_archive.`size_bytes`
      AND source_archive.`size_bytes`
        = NEW.`accepted_end_lba_exclusive` * 2048
      AND (
        source_archive.`integrity` = 'unknown'
        OR (
          json_array_length(NEW.`unrecovered_source_ranges`) = 0
          AND source_archive.`integrity` = 'clean_read'
          AND source_archive.`integrity_policy_version`
            = NEW.`evidence_format`
          AND source_archive.`bad_sector_count` = 0
          AND source_archive.`bad_area_count` = 0
          AND json(source_archive.`bad_sector_ranges`) = json('[]')
          AND source_archive.`bad_sector_counts_by_title` IS NULL
        )
      )
  ) THEN RAISE(
    ABORT,
    'DVD evidence header must reference its proven DVD archive and completed marked Archive Job'
  ) END;
END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_header_update_guard`
BEFORE UPDATE ON `dvd_archive_evidence_headers`
BEGIN
  SELECT RAISE(ABORT, 'DVD evidence header is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_header_delete_guard`
BEFORE DELETE ON `dvd_archive_evidence_headers`
BEGIN
  SELECT RAISE(ABORT, 'DVD evidence header is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_incomplete_archive_insert_guard`
BEFORE INSERT ON `original_disc_archives`
WHEN NEW.`integrity` = 'incomplete_read'
BEGIN
  SELECT RAISE(
    ABORT,
    'Incomplete-read Archive Integrity requires authoritative DVD evidence'
  );
END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_incomplete_archive_update_guard`
BEFORE UPDATE ON `original_disc_archives`
WHEN NEW.`integrity` = 'incomplete_read'
  AND NOT EXISTS (
    SELECT 1
    FROM `dvd_archive_evidence_headers`
    WHERE `original_disc_archive_id` = NEW.`id`
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'Incomplete-read Archive Integrity requires authoritative DVD evidence'
  );
END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_archive_projection_update_guard`
BEFORE UPDATE ON `original_disc_archives`
WHEN EXISTS (
  SELECT 1
  FROM `dvd_archive_evidence_headers`
  WHERE `original_disc_archive_id` = NEW.`id`
)
  AND NOT EXISTS (
    SELECT 1
    FROM `dvd_archive_evidence_headers` AS evidence_header
    WHERE evidence_header.`original_disc_archive_id` = NEW.`id`
      AND NEW.`disc_kind` = 'dvd'
      AND NEW.`boundary_policy_version` IS NOT NULL
      AND NEW.`boundary_published_size_bytes` = NEW.`size_bytes`
      AND NEW.`size_bytes`
        = evidence_header.`accepted_end_lba_exclusive` * 2048
      AND EXISTS (
        SELECT 1
        FROM `archive_jobs` AS source_job
        INNER JOIN `archive_requests` AS source_request
          ON source_request.`id` = source_job.`archive_request_id`
        INNER JOIN `disc_inspections` AS source_inspection
          ON source_inspection.`id` = source_job.`disc_inspection_id`
        WHERE source_job.`id` = evidence_header.`source_archive_job_id`
          AND source_job.`original_disc_archive_id` = NEW.`id`
          AND source_job.`evidence_format` = evidence_header.`evidence_format`
          AND source_job.`status` = 'completed'
          AND source_job.`detected_disc_id` = NEW.`detected_disc_id`
          AND source_request.`detected_disc_id` = NEW.`detected_disc_id`
          AND source_request.`evidence_format`
            = evidence_header.`evidence_format`
          AND source_request.`status` = 'fulfilled'
          AND source_inspection.`detected_disc_id` = NEW.`detected_disc_id`
          AND source_inspection.`status` = 'completed'
      )
      AND (
        (
          json_array_length(evidence_header.`unrecovered_source_ranges`) = 0
          AND NEW.`integrity` = 'clean_read'
          AND NEW.`integrity_policy_version`
            = evidence_header.`evidence_format`
          AND NEW.`bad_sector_count` = 0
          AND NEW.`bad_area_count` = 0
          AND json(NEW.`bad_sector_ranges`) = json('[]')
          AND NEW.`bad_sector_counts_by_title` IS NULL
        )
        OR (
          json_array_length(evidence_header.`unrecovered_source_ranges`) > 0
          AND NEW.`integrity` = 'incomplete_read'
          AND NEW.`integrity_policy_version`
            = evidence_header.`evidence_format`
          AND NEW.`bad_sector_count` = (
            SELECT sum(json_extract(source_range.`value`, '$.sectorCount'))
            FROM json_each(
              evidence_header.`unrecovered_source_ranges`
            ) AS source_range
          )
          AND NEW.`bad_area_count` = json_array_length(
            evidence_header.`unrecovered_source_ranges`
          )
          AND json_valid(NEW.`bad_sector_ranges`)
          AND json_type(NEW.`bad_sector_ranges`) = 'array'
          AND json_array_length(NEW.`bad_sector_ranges`)
            = json_array_length(
              evidence_header.`unrecovered_source_ranges`
            )
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(
              evidence_header.`unrecovered_source_ranges`
            ) AS source_range
            LEFT JOIN json_each(NEW.`bad_sector_ranges`) AS projected_range
              ON projected_range.`key` = source_range.`key`
            WHERE projected_range.`key` IS NULL
              OR json_type(projected_range.`value`) IS NOT 'object'
              OR (SELECT count(*) FROM json_each(projected_range.`value`)) <> 2
              OR json_type(
                projected_range.`value`,
                '$.startLba'
              ) IS NOT 'integer'
              OR json_type(
                projected_range.`value`,
                '$.sectorCount'
              ) IS NOT 'integer'
              OR json_extract(projected_range.`value`, '$.startLba')
                <> json_extract(source_range.`value`, '$.startLba')
              OR json_extract(projected_range.`value`, '$.sectorCount')
                <> json_extract(source_range.`value`, '$.sectorCount')
          )
          AND NEW.`bad_sector_counts_by_title` IS NULL
        )
      )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'Archive Integrity projection must match authoritative DVD evidence'
  );
END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_archive_recovery_insert_guard`
BEFORE INSERT ON `archive_recoveries`
WHEN NOT EXISTS (
  SELECT 1
  FROM `dvd_archive_evidence_headers` AS evidence_header
  WHERE evidence_header.`original_disc_archive_id`
    = NEW.`original_disc_archive_id`
    AND (
      (
        json_array_length(evidence_header.`unrecovered_source_ranges`) = 0
        AND NEW.`status` = 'completed'
      )
      OR (
        json_array_length(evidence_header.`unrecovered_source_ranges`) > 0
        AND NEW.`status` = 'eligible'
      )
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Archive Recovery status must match authoritative DVD evidence'
  );
END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_archive_recovery_update_guard`
BEFORE UPDATE ON `archive_recoveries`
WHEN NOT EXISTS (
  SELECT 1
  FROM `dvd_archive_evidence_headers` AS evidence_header
  WHERE evidence_header.`original_disc_archive_id`
    = NEW.`original_disc_archive_id`
    AND (
      (
        json_array_length(evidence_header.`unrecovered_source_ranges`) = 0
        AND NEW.`status` = 'completed'
      )
      OR (
        json_array_length(evidence_header.`unrecovered_source_ranges`) > 0
        AND NEW.`status` = 'eligible'
      )
    )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Archive Recovery status must match authoritative DVD evidence'
  );
END;
