DROP TRIGGER IF EXISTS `dvd_evidence_header_insert_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_header_update_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_header_delete_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_incomplete_archive_insert_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_incomplete_archive_update_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_archive_boundary_update_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_archive_projection_update_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_archive_recovery_insert_guard`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_archive_recovery_update_guard`;--> statement-breakpoint
CREATE TEMP TABLE `__dvd_evidence_checkpoint_migration_guard` (
  `interstitial_header_count` integer NOT NULL,
  CONSTRAINT "dvd_evidence_checkpoint_migration_requires_empty_header" CHECK(`interstitial_header_count` = 0)
);--> statement-breakpoint
INSERT INTO `__dvd_evidence_checkpoint_migration_guard` (`interstitial_header_count`)
SELECT count(*) FROM `dvd_archive_evidence_headers`;--> statement-breakpoint
DROP TABLE `__dvd_evidence_checkpoint_migration_guard`;--> statement-breakpoint
ALTER TABLE `original_disc_archives` ADD `integrity_evidence_revision` integer CHECK(`integrity_evidence_revision` is null or (typeof(`integrity_evidence_revision`) = 'integer' and `integrity_evidence_revision` > 0 and `integrity` in ('clean_read', 'incomplete_read') and `integrity_policy_version` = 'dvd-recovery-evidence-v1'));--> statement-breakpoint
CREATE TABLE `dvd_archive_evidence_manifests` (
	`id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL,
	`revision` integer NOT NULL,
	`previous_manifest_id` text,
	`recovery_read_id` text,
	`evidence_format` text NOT NULL,
	`image_fingerprint` text NOT NULL,
	`sector_size_bytes` integer NOT NULL,
	`accepted_end_lba_exclusive` integer NOT NULL,
	`boundary_policy_version` text NOT NULL,
	`boundary_reported_size_bytes` integer NOT NULL,
	`boundary_published_size_bytes` integer NOT NULL,
	`boundary_evidence_digest` text NOT NULL,
	`unrecovered_source_ranges` text NOT NULL,
	`unrecovered_source_ranges_digest` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_archive_evidence_manifests_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_archive_evidence_manifests_previous_manifest_id_dvd_archive_evidence_manifests_id_fk` FOREIGN KEY (`previous_manifest_id`) REFERENCES `dvd_archive_evidence_manifests`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_archive_evidence_manifests_recovery_read_id_dvd_archive_recovery_reads_id_fk` FOREIGN KEY (`recovery_read_id`) REFERENCES `dvd_archive_recovery_reads`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_archive_evidence_manifests_id_not_null" CHECK("id" is not null),
	CONSTRAINT "dvd_archive_evidence_manifests_revision_check" CHECK(typeof("revision") = 'integer' and "revision" > 0 and (("revision" = 1 and "previous_manifest_id" is null and "recovery_read_id" is null) or ("revision" > 1 and "previous_manifest_id" is not null and "recovery_read_id" is not null))),
	CONSTRAINT "dvd_archive_evidence_manifests_extent_check" CHECK("sector_size_bytes" = 2048 and typeof("accepted_end_lba_exclusive") = 'integer' and "accepted_end_lba_exclusive" > 0 and typeof("boundary_reported_size_bytes") = 'integer' and "boundary_reported_size_bytes" > 0 and typeof("boundary_published_size_bytes") = 'integer' and "boundary_published_size_bytes" = "accepted_end_lba_exclusive" * "sector_size_bytes" and "boundary_published_size_bytes" <= "boundary_reported_size_bytes"),
	CONSTRAINT "dvd_archive_evidence_manifests_source_ranges_check" CHECK(json_valid("unrecovered_source_ranges") and json_type("unrecovered_source_ranges") = 'array'),
	CONSTRAINT "dvd_archive_evidence_manifests_identity_check" CHECK(length("image_fingerprint") between 1 and 512 and length("boundary_policy_version") between 1 and 128 and length("boundary_evidence_digest") = 64 and "boundary_evidence_digest" not glob '*[^0-9a-f]*' and length("unrecovered_source_ranges_digest") = 64 and "unrecovered_source_ranges_digest" not glob '*[^0-9a-f]*' and length("manifest_digest") = 64 and "manifest_digest" not glob '*[^0-9a-f]*')
);--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_archive_evidence_manifests_archive_revision_unique` ON `dvd_archive_evidence_manifests` (`original_disc_archive_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_archive_evidence_manifests_archive_digest_unique` ON `dvd_archive_evidence_manifests` (`original_disc_archive_id`,`manifest_digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_archive_evidence_manifests_recovery_read_unique` ON `dvd_archive_evidence_manifests` (`recovery_read_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_dvd_archive_evidence_headers` (
	`original_disc_archive_id` text PRIMARY KEY,
	`source_archive_job_id` text NOT NULL,
	`evidence_format` text NOT NULL,
	`boundary_policy_version` text NOT NULL,
	`boundary_reported_size_bytes` integer NOT NULL,
	`boundary_published_size_bytes` integer NOT NULL,
	`boundary_evidence_digest` text NOT NULL,
	`sector_size_bytes` integer NOT NULL,
	`accepted_end_lba_exclusive` integer NOT NULL,
	`current_manifest_id` text NOT NULL,
	`current_manifest_revision` integer NOT NULL,
	`current_manifest_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_archive_evidence_headers_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_archive_evidence_headers_source_archive_job_id_archive_jobs_id_fk` FOREIGN KEY (`source_archive_job_id`) REFERENCES `archive_jobs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_archive_evidence_headers_current_manifest_id_dvd_archive_evidence_manifests_id_fk` FOREIGN KEY (`current_manifest_id`) REFERENCES `dvd_archive_evidence_manifests`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_archive_evidence_headers_archive_id_not_null" CHECK("original_disc_archive_id" is not null),
	CONSTRAINT "dvd_archive_evidence_headers_format_check" CHECK("evidence_format" in ('dvd-recovery-evidence-v1')),
	CONSTRAINT "dvd_archive_evidence_headers_extent_check" CHECK(typeof("accepted_end_lba_exclusive") = 'integer' and "accepted_end_lba_exclusive" > 0),
	CONSTRAINT "dvd_archive_evidence_headers_boundary_check" CHECK(length("boundary_policy_version") between 1 and 128 and length("boundary_evidence_digest") = 64 and "boundary_evidence_digest" not glob '*[^0-9a-f]*' and "sector_size_bytes" = 2048 and typeof("boundary_reported_size_bytes") = 'integer' and "boundary_reported_size_bytes" > 0 and typeof("boundary_published_size_bytes") = 'integer' and "boundary_published_size_bytes" = "accepted_end_lba_exclusive" * "sector_size_bytes" and "boundary_published_size_bytes" <= "boundary_reported_size_bytes"),
	CONSTRAINT "dvd_archive_evidence_headers_current_revision_check" CHECK(typeof("current_manifest_revision") = 'integer' and "current_manifest_revision" > 0 and length("current_manifest_digest") = 64 and "current_manifest_digest" not glob '*[^0-9a-f]*')
);--> statement-breakpoint
DROP TABLE `dvd_archive_evidence_headers`;--> statement-breakpoint
ALTER TABLE `__new_dvd_archive_evidence_headers` RENAME TO `dvd_archive_evidence_headers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_archive_evidence_headers_job_unique` ON `dvd_archive_evidence_headers` (`source_archive_job_id`);--> statement-breakpoint
CREATE TABLE `dvd_archive_recovery_reads` (
	`id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL,
	`from_manifest_id` text NOT NULL,
	`from_manifest_revision` integer NOT NULL,
	`start_lba` integer NOT NULL,
	`sector_count` integer NOT NULL,
	`outcome` text NOT NULL,
	`evidence_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_archive_recovery_reads_original_disc_archive_id_dvd_archive_evidence_headers_original_disc_archive_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `dvd_archive_evidence_headers`(`original_disc_archive_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_archive_recovery_reads_from_manifest_id_dvd_archive_evidence_manifests_id_fk` FOREIGN KEY (`from_manifest_id`) REFERENCES `dvd_archive_evidence_manifests`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_archive_recovery_reads_id_not_null" CHECK("id" is not null),
	CONSTRAINT "dvd_archive_recovery_reads_revision_check" CHECK(typeof("from_manifest_revision") = 'integer' and "from_manifest_revision" > 0),
	CONSTRAINT "dvd_archive_recovery_reads_sector_check" CHECK(typeof("start_lba") = 'integer' and "start_lba" >= 0 and "sector_count" = 1),
	CONSTRAINT "dvd_archive_recovery_reads_outcome_check" CHECK("outcome" in ('recovered', 'failed') and length("evidence_digest") = 64 and "evidence_digest" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_manifest_insert_guard`
BEFORE INSERT ON `dvd_archive_evidence_manifests`
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.`unrecovered_source_ranges`) AS source_range
    WHERE json_type(source_range.`value`) IS NOT 'object'
      OR (SELECT count(*) FROM json_each(source_range.`value`)) <> 3
      OR json_type(source_range.`value`, '$.startLba') IS NOT 'integer'
      OR json_extract(source_range.`value`, '$.startLba') NOT BETWEEN 0 AND 9007199254740991
      OR json_type(source_range.`value`, '$.sectorCount') IS NOT 'integer'
      OR json_extract(source_range.`value`, '$.sectorCount') NOT BETWEEN 1 AND 9007199254740991
      OR json_type(source_range.`value`, '$.classification') IS NOT 'text'
      OR json_extract(source_range.`value`, '$.classification') NOT IN ('skipped_untested', 'individually_failed')
      OR json_extract(source_range.`value`, '$.startLba') + json_extract(source_range.`value`, '$.sectorCount') > NEW.`accepted_end_lba_exclusive`
  ) THEN RAISE(ABORT, 'DVD evidence manifest source ranges must be valid and inside the accepted extent') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.`unrecovered_source_ranges`) AS current_range
    INNER JOIN json_each(NEW.`unrecovered_source_ranges`) AS previous_range
      ON CAST(previous_range.`key` AS integer) = CAST(current_range.`key` AS integer) - 1
    WHERE json_extract(current_range.`value`, '$.startLba') < json_extract(previous_range.`value`, '$.startLba') + json_extract(previous_range.`value`, '$.sectorCount')
      OR (
        json_extract(current_range.`value`, '$.startLba') = json_extract(previous_range.`value`, '$.startLba') + json_extract(previous_range.`value`, '$.sectorCount')
        AND json_extract(current_range.`value`, '$.classification') = json_extract(previous_range.`value`, '$.classification')
      )
  ) THEN RAISE(ABORT, 'DVD evidence manifest source ranges must be canonically normalized') END;

  SELECT CASE WHEN NEW.`revision` = 1 AND (
    EXISTS (
      SELECT 1 FROM json_each(NEW.`unrecovered_source_ranges`) AS source_range
      WHERE json_extract(source_range.`value`, '$.classification') <> 'skipped_untested'
    )
    OR EXISTS (
      SELECT 1 FROM `dvd_archive_evidence_headers`
      WHERE `original_disc_archive_id` = NEW.`original_disc_archive_id`
    )
    OR NOT EXISTS (
      SELECT 1 FROM `original_disc_archives` AS source_archive
      WHERE source_archive.`id` = NEW.`original_disc_archive_id`
        AND source_archive.`disc_kind` = 'dvd'
        AND source_archive.`fingerprint` = NEW.`image_fingerprint`
        AND source_archive.`boundary_policy_version` = NEW.`boundary_policy_version`
        AND source_archive.`boundary_reported_size_bytes` = NEW.`boundary_reported_size_bytes`
        AND source_archive.`boundary_published_size_bytes` = NEW.`boundary_published_size_bytes`
        AND source_archive.`size_bytes` = NEW.`boundary_published_size_bytes`
        AND NEW.`evidence_format` = 'dvd-recovery-evidence-v1'
    )
  ) THEN RAISE(ABORT, 'Initial DVD evidence manifest must bind the DVD image and contain only skipped source ranges') END;

  SELECT CASE WHEN NEW.`revision` > 1 AND NOT EXISTS (
    SELECT 1
    FROM `dvd_archive_evidence_headers` AS evidence_header
    INNER JOIN `dvd_archive_evidence_manifests` AS previous_manifest
      ON previous_manifest.`id` = evidence_header.`current_manifest_id`
    INNER JOIN `dvd_archive_recovery_reads` AS recovery_read
      ON recovery_read.`id` = NEW.`recovery_read_id`
    WHERE evidence_header.`original_disc_archive_id` = NEW.`original_disc_archive_id`
      AND NEW.`revision` = evidence_header.`current_manifest_revision` + 1
      AND NEW.`previous_manifest_id` = previous_manifest.`id`
      AND recovery_read.`original_disc_archive_id` = NEW.`original_disc_archive_id`
      AND recovery_read.`from_manifest_id` = previous_manifest.`id`
      AND recovery_read.`from_manifest_revision` = previous_manifest.`revision`
      AND NEW.`evidence_format` = previous_manifest.`evidence_format`
      AND NEW.`image_fingerprint` = previous_manifest.`image_fingerprint`
      AND NEW.`sector_size_bytes` = previous_manifest.`sector_size_bytes`
      AND NEW.`accepted_end_lba_exclusive` = previous_manifest.`accepted_end_lba_exclusive`
      AND NEW.`boundary_policy_version` = previous_manifest.`boundary_policy_version`
      AND NEW.`boundary_reported_size_bytes` = previous_manifest.`boundary_reported_size_bytes`
      AND NEW.`boundary_published_size_bytes` = previous_manifest.`boundary_published_size_bytes`
      AND NEW.`boundary_evidence_digest` = previous_manifest.`boundary_evidence_digest`
      AND EXISTS (
        SELECT 1 FROM json_each(previous_manifest.`unrecovered_source_ranges`) AS previous_range
        WHERE recovery_read.`start_lba` >= json_extract(previous_range.`value`, '$.startLba')
          AND recovery_read.`start_lba` < json_extract(previous_range.`value`, '$.startLba') + json_extract(previous_range.`value`, '$.sectorCount')
          AND (recovery_read.`outcome` = 'recovered' OR json_extract(previous_range.`value`, '$.classification') = 'skipped_untested')
      )
      AND (
        (recovery_read.`outcome` = 'recovered' AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.`unrecovered_source_ranges`) AS next_range
          WHERE recovery_read.`start_lba` >= json_extract(next_range.`value`, '$.startLba')
            AND recovery_read.`start_lba` < json_extract(next_range.`value`, '$.startLba') + json_extract(next_range.`value`, '$.sectorCount')
        ))
        OR
        (recovery_read.`outcome` = 'failed' AND EXISTS (
          SELECT 1 FROM json_each(NEW.`unrecovered_source_ranges`) AS next_range
          WHERE recovery_read.`start_lba` >= json_extract(next_range.`value`, '$.startLba')
            AND recovery_read.`start_lba` < json_extract(next_range.`value`, '$.startLba') + json_extract(next_range.`value`, '$.sectorCount')
            AND json_extract(next_range.`value`, '$.classification') = 'individually_failed'
        ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.`unrecovered_source_ranges`) AS next_range
        WHERE (
          json_extract(next_range.`value`, '$.startLba') < recovery_read.`start_lba`
          AND NOT EXISTS (
            SELECT 1 FROM json_each(previous_manifest.`unrecovered_source_ranges`) AS previous_range
            WHERE json_extract(previous_range.`value`, '$.classification') = json_extract(next_range.`value`, '$.classification')
              AND json_extract(previous_range.`value`, '$.startLba') <= json_extract(next_range.`value`, '$.startLba')
              AND json_extract(previous_range.`value`, '$.startLba') + json_extract(previous_range.`value`, '$.sectorCount') >= min(json_extract(next_range.`value`, '$.startLba') + json_extract(next_range.`value`, '$.sectorCount'), recovery_read.`start_lba`)
          )
        ) OR (
          json_extract(next_range.`value`, '$.startLba') + json_extract(next_range.`value`, '$.sectorCount') > recovery_read.`start_lba` + 1
          AND NOT EXISTS (
            SELECT 1 FROM json_each(previous_manifest.`unrecovered_source_ranges`) AS previous_range
            WHERE json_extract(previous_range.`value`, '$.classification') = json_extract(next_range.`value`, '$.classification')
              AND json_extract(previous_range.`value`, '$.startLba') <= max(json_extract(next_range.`value`, '$.startLba'), recovery_read.`start_lba` + 1)
              AND json_extract(previous_range.`value`, '$.startLba') + json_extract(previous_range.`value`, '$.sectorCount') >= json_extract(next_range.`value`, '$.startLba') + json_extract(next_range.`value`, '$.sectorCount')
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(previous_manifest.`unrecovered_source_ranges`) AS previous_range
        WHERE (
          json_extract(previous_range.`value`, '$.startLba') < recovery_read.`start_lba`
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.`unrecovered_source_ranges`) AS next_range
            WHERE json_extract(next_range.`value`, '$.classification') = json_extract(previous_range.`value`, '$.classification')
              AND json_extract(next_range.`value`, '$.startLba') <= json_extract(previous_range.`value`, '$.startLba')
              AND json_extract(next_range.`value`, '$.startLba') + json_extract(next_range.`value`, '$.sectorCount') >= min(json_extract(previous_range.`value`, '$.startLba') + json_extract(previous_range.`value`, '$.sectorCount'), recovery_read.`start_lba`)
          )
        ) OR (
          json_extract(previous_range.`value`, '$.startLba') + json_extract(previous_range.`value`, '$.sectorCount') > recovery_read.`start_lba` + 1
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.`unrecovered_source_ranges`) AS next_range
            WHERE json_extract(next_range.`value`, '$.classification') = json_extract(previous_range.`value`, '$.classification')
              AND json_extract(next_range.`value`, '$.startLba') <= max(json_extract(previous_range.`value`, '$.startLba'), recovery_read.`start_lba` + 1)
              AND json_extract(next_range.`value`, '$.startLba') + json_extract(next_range.`value`, '$.sectorCount') >= json_extract(previous_range.`value`, '$.startLba') + json_extract(previous_range.`value`, '$.sectorCount')
          )
        )
      )
  ) THEN RAISE(ABORT, 'DVD evidence manifest transition requires its one-sector recovery read and exact predecessor state') END;
END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_manifest_update_guard`
BEFORE UPDATE ON `dvd_archive_evidence_manifests`
BEGIN SELECT RAISE(ABORT, 'DVD evidence manifest is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_manifest_delete_guard`
BEFORE DELETE ON `dvd_archive_evidence_manifests`
BEGIN SELECT RAISE(ABORT, 'DVD evidence manifest is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_recovery_read_insert_guard`
BEFORE INSERT ON `dvd_archive_recovery_reads`
WHEN NOT EXISTS (
  SELECT 1
  FROM `dvd_archive_evidence_headers` AS evidence_header
  INNER JOIN `dvd_archive_evidence_manifests` AS current_manifest
    ON current_manifest.`id` = evidence_header.`current_manifest_id`
  INNER JOIN json_each(current_manifest.`unrecovered_source_ranges`) AS source_range
  WHERE evidence_header.`original_disc_archive_id` = NEW.`original_disc_archive_id`
    AND evidence_header.`current_manifest_id` = NEW.`from_manifest_id`
    AND evidence_header.`current_manifest_revision` = NEW.`from_manifest_revision`
    AND NEW.`start_lba` >= json_extract(source_range.`value`, '$.startLba')
    AND NEW.`start_lba` < json_extract(source_range.`value`, '$.startLba') + json_extract(source_range.`value`, '$.sectorCount')
)
BEGIN SELECT RAISE(ABORT, 'DVD recovery read must be a one-sector read of the current unrecovered manifest'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_recovery_read_update_guard`
BEFORE UPDATE ON `dvd_archive_recovery_reads`
BEGIN SELECT RAISE(ABORT, 'DVD recovery read evidence is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_recovery_read_delete_guard`
BEFORE DELETE ON `dvd_archive_recovery_reads`
BEGIN SELECT RAISE(ABORT, 'DVD recovery read evidence is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_header_insert_guard`
BEFORE INSERT ON `dvd_archive_evidence_headers`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM `dvd_archive_evidence_manifests` AS current_manifest
    INNER JOIN `original_disc_archives` AS source_archive
      ON source_archive.`id` = NEW.`original_disc_archive_id`
    INNER JOIN `detected_discs` AS source_detected_disc
      ON source_detected_disc.`id` = source_archive.`detected_disc_id`
    INNER JOIN `archive_jobs` AS source_job
      ON source_job.`id` = NEW.`source_archive_job_id`
    INNER JOIN `archive_requests` AS source_request
      ON source_request.`id` = source_job.`archive_request_id`
    INNER JOIN `detected_discs` AS requested_detected_disc
      ON requested_detected_disc.`id` = source_request.`detected_disc_id`
    INNER JOIN `disc_inspections` AS source_inspection
      ON source_inspection.`id` = source_job.`disc_inspection_id`
    WHERE NEW.`current_manifest_revision` = 1
      AND current_manifest.`id` = NEW.`current_manifest_id`
      AND current_manifest.`original_disc_archive_id` = NEW.`original_disc_archive_id`
      AND current_manifest.`revision` = NEW.`current_manifest_revision`
      AND current_manifest.`manifest_digest` = NEW.`current_manifest_digest`
      AND current_manifest.`evidence_format` = NEW.`evidence_format`
      AND current_manifest.`image_fingerprint` = source_archive.`fingerprint`
      AND current_manifest.`sector_size_bytes` = NEW.`sector_size_bytes`
      AND current_manifest.`accepted_end_lba_exclusive` = NEW.`accepted_end_lba_exclusive`
      AND current_manifest.`boundary_policy_version` = NEW.`boundary_policy_version`
      AND current_manifest.`boundary_reported_size_bytes` = NEW.`boundary_reported_size_bytes`
      AND current_manifest.`boundary_published_size_bytes` = NEW.`boundary_published_size_bytes`
      AND current_manifest.`boundary_evidence_digest` = NEW.`boundary_evidence_digest`
      AND source_archive.`disc_kind` = 'dvd'
      AND source_detected_disc.`disc_kind` = source_archive.`disc_kind`
      AND source_detected_disc.`fingerprint` = source_archive.`fingerprint`
      AND source_archive.`boundary_policy_version` = NEW.`boundary_policy_version`
      AND source_archive.`boundary_reported_size_bytes` = NEW.`boundary_reported_size_bytes`
      AND source_archive.`boundary_published_size_bytes` = NEW.`boundary_published_size_bytes`
      AND source_archive.`size_bytes` = NEW.`boundary_published_size_bytes`
      AND source_job.`original_disc_archive_id` = NEW.`original_disc_archive_id`
      AND source_job.`detected_disc_id` = source_archive.`detected_disc_id`
      AND source_job.`evidence_format` = NEW.`evidence_format`
      AND source_job.`status` = 'completed'
      AND (
        source_request.`detected_disc_id` = source_archive.`detected_disc_id`
        OR (
          requested_detected_disc.`disc_kind` = 'dvd'
          AND requested_detected_disc.`status` = CASE
            WHEN source_request.`rearchive_source_archive_id` IS NULL
              THEN 'approved'
            ELSE 'archived'
          END
          AND NOT EXISTS (
            SELECT 1
            FROM `archive_jobs` AS request_attempt
            INNER JOIN `disc_inspections` AS request_attempt_inspection
              ON request_attempt_inspection.`id` = request_attempt.`disc_inspection_id`
            WHERE request_attempt.`archive_request_id` = source_request.`id`
              AND request_attempt_inspection.`total_bytes` IS NOT NULL
              AND request_attempt_inspection.`total_bytes` <> NEW.`boundary_reported_size_bytes`
          )
          AND (
            (
              source_request.`rearchive_source_archive_id` IS NULL
              AND json_valid(source_detected_disc.`scan_data`)
              AND json_extract(source_detected_disc.`scan_data`, '$.schemaVersion') = 2
              AND json_extract(source_detected_disc.`scan_data`, '$.contentId') = source_detected_disc.`fingerprint`
              AND requested_detected_disc.`fingerprint` = source_detected_disc.`fingerprint`
              AND json_valid(requested_detected_disc.`scan_data`)
              AND json_extract(requested_detected_disc.`scan_data`, '$.schemaVersion') = 2
              AND json_extract(requested_detected_disc.`scan_data`, '$.contentId') = source_detected_disc.`fingerprint`
            )
            OR (
              source_request.`rearchive_source_archive_id` IS NOT NULL
              AND source_archive.`rearchive_source_archive_id` = source_request.`rearchive_source_archive_id`
            )
          )
        )
      )
      AND source_request.`evidence_format` = NEW.`evidence_format`
      AND source_request.`status` = 'fulfilled'
      AND source_inspection.`detected_disc_id` = source_archive.`detected_disc_id`
      AND source_inspection.`status` = 'completed'
      AND source_inspection.`total_bytes` = NEW.`boundary_reported_size_bytes`
      AND ((source_archive.`integrity` = 'unknown'
        AND source_archive.`integrity_evidence_revision` IS NULL) OR (
        json_array_length(current_manifest.`unrecovered_source_ranges`) = 0
        AND source_archive.`integrity` = 'clean_read'
        AND source_archive.`integrity_evidence_revision` = 1
        AND source_archive.`integrity_policy_version` = NEW.`evidence_format`
        AND source_archive.`bad_sector_count` = 0
        AND source_archive.`bad_area_count` = 0
        AND json(source_archive.`bad_sector_ranges`) = json('[]')
        AND source_archive.`bad_sector_counts_by_title` IS NULL
      ))
  ) THEN RAISE(ABORT, 'DVD evidence header must reference its proven initial manifest, DVD boundary, and completed marked Archive Job') END;
END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_header_update_guard`
BEFORE UPDATE ON `dvd_archive_evidence_headers`
WHEN OLD.`original_disc_archive_id` IS NOT NEW.`original_disc_archive_id`
  OR OLD.`source_archive_job_id` IS NOT NEW.`source_archive_job_id`
  OR OLD.`evidence_format` IS NOT NEW.`evidence_format`
  OR OLD.`boundary_policy_version` IS NOT NEW.`boundary_policy_version`
  OR OLD.`boundary_reported_size_bytes` IS NOT NEW.`boundary_reported_size_bytes`
  OR OLD.`boundary_published_size_bytes` IS NOT NEW.`boundary_published_size_bytes`
  OR OLD.`boundary_evidence_digest` IS NOT NEW.`boundary_evidence_digest`
  OR OLD.`sector_size_bytes` IS NOT NEW.`sector_size_bytes`
  OR OLD.`accepted_end_lba_exclusive` IS NOT NEW.`accepted_end_lba_exclusive`
  OR OLD.`created_at` IS NOT NEW.`created_at`
  OR NEW.`updated_at` < OLD.`updated_at`
  OR NEW.`current_manifest_revision` <> OLD.`current_manifest_revision` + 1
  OR NOT EXISTS (
    SELECT 1 FROM `dvd_archive_evidence_manifests` AS current_manifest
    WHERE current_manifest.`id` = NEW.`current_manifest_id`
      AND current_manifest.`original_disc_archive_id` = NEW.`original_disc_archive_id`
      AND current_manifest.`revision` = NEW.`current_manifest_revision`
      AND current_manifest.`previous_manifest_id` = OLD.`current_manifest_id`
      AND current_manifest.`manifest_digest` = NEW.`current_manifest_digest`
  )
BEGIN SELECT RAISE(ABORT, 'DVD evidence header may only advance to its next committed manifest'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_header_delete_guard`
BEFORE DELETE ON `dvd_archive_evidence_headers`
BEGIN SELECT RAISE(ABORT, 'DVD evidence header is immutable'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_incomplete_archive_insert_guard`
BEFORE INSERT ON `original_disc_archives`
WHEN NEW.`integrity` = 'incomplete_read'
BEGIN SELECT RAISE(ABORT, 'Incomplete-read Archive Integrity requires authoritative DVD evidence'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_incomplete_archive_update_guard`
BEFORE UPDATE ON `original_disc_archives`
WHEN NEW.`integrity` = 'incomplete_read'
  AND NOT EXISTS (SELECT 1 FROM `dvd_archive_evidence_headers` WHERE `original_disc_archive_id` = NEW.`id`)
BEGIN SELECT RAISE(ABORT, 'Incomplete-read Archive Integrity requires authoritative DVD evidence'); END;
--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_archive_boundary_update_guard`
BEFORE UPDATE ON `original_disc_archives`
WHEN EXISTS (SELECT 1 FROM `dvd_archive_evidence_headers` WHERE `original_disc_archive_id` = NEW.`id`)
  AND (
    OLD.`boundary_policy_version` IS NOT NEW.`boundary_policy_version`
    OR OLD.`boundary_reported_size_bytes` IS NOT NEW.`boundary_reported_size_bytes`
    OR OLD.`boundary_published_size_bytes` IS NOT NEW.`boundary_published_size_bytes`
    OR OLD.`boundary_excluded_sector_count` IS NOT NEW.`boundary_excluded_sector_count`
    OR OLD.`boundary_first_excluded_lba` IS NOT NEW.`boundary_first_excluded_lba`
    OR OLD.`boundary_maximum_referenced_lba` IS NOT NEW.`boundary_maximum_referenced_lba`
    OR OLD.`boundary_read_failure_classifier_version` IS NOT NEW.`boundary_read_failure_classifier_version`
    OR OLD.`boundary_read_failure_scsi_status` IS NOT NEW.`boundary_read_failure_scsi_status`
    OR OLD.`boundary_read_failure_host_status` IS NOT NEW.`boundary_read_failure_host_status`
    OR OLD.`boundary_read_failure_driver_status` IS NOT NEW.`boundary_read_failure_driver_status`
    OR OLD.`boundary_read_failure_sense_response_code` IS NOT NEW.`boundary_read_failure_sense_response_code`
    OR OLD.`boundary_read_failure_sense_key` IS NOT NEW.`boundary_read_failure_sense_key`
    OR OLD.`boundary_read_failure_asc` IS NOT NEW.`boundary_read_failure_asc`
    OR OLD.`boundary_read_failure_ascq` IS NOT NEW.`boundary_read_failure_ascq`
  )
BEGIN SELECT RAISE(ABORT, 'Archive Boundary Evidence is immutable once authoritative DVD evidence exists'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_archive_projection_update_guard`
BEFORE UPDATE ON `original_disc_archives`
WHEN EXISTS (SELECT 1 FROM `dvd_archive_evidence_headers` WHERE `original_disc_archive_id` = NEW.`id`)
  AND (
    OLD.`detected_disc_id` IS NOT NEW.`detected_disc_id`
    OR OLD.`disc_kind` IS NOT NEW.`disc_kind`
    OR OLD.`fingerprint` IS NOT NEW.`fingerprint`
    OR OLD.`size_bytes` IS NOT NEW.`size_bytes`
    OR OLD.`integrity` IS NOT NEW.`integrity`
    OR OLD.`integrity_evidence_revision` IS NOT NEW.`integrity_evidence_revision`
    OR OLD.`integrity_policy_version` IS NOT NEW.`integrity_policy_version`
    OR OLD.`bad_sector_count` IS NOT NEW.`bad_sector_count`
    OR OLD.`bad_area_count` IS NOT NEW.`bad_area_count`
    OR OLD.`bad_sector_ranges` IS NOT NEW.`bad_sector_ranges`
    OR OLD.`bad_sector_counts_by_title` IS NOT NEW.`bad_sector_counts_by_title`
  )
  AND (
    NEW.`integrity_evidence_revision` IS NULL
    OR (OLD.`integrity_evidence_revision` IS NOT NULL
      AND NEW.`integrity_evidence_revision` < OLD.`integrity_evidence_revision`)
    OR NOT EXISTS (
      SELECT 1
      FROM `dvd_archive_evidence_headers` AS evidence_header
      INNER JOIN `archive_jobs` AS source_job ON source_job.`id` = evidence_header.`source_archive_job_id`
      INNER JOIN `archive_requests` AS source_request ON source_request.`id` = source_job.`archive_request_id`
      INNER JOIN `detected_discs` AS source_detected_disc ON source_detected_disc.`id` = NEW.`detected_disc_id`
      INNER JOIN `detected_discs` AS requested_detected_disc ON requested_detected_disc.`id` = source_request.`detected_disc_id`
      INNER JOIN `disc_inspections` AS source_inspection ON source_inspection.`id` = source_job.`disc_inspection_id`
      INNER JOIN `dvd_archive_evidence_manifests` AS committed_manifest
        ON committed_manifest.`original_disc_archive_id` = evidence_header.`original_disc_archive_id`
        AND committed_manifest.`revision` = NEW.`integrity_evidence_revision`
        AND NEW.`integrity_evidence_revision` <= evidence_header.`current_manifest_revision`
      WHERE evidence_header.`original_disc_archive_id` = NEW.`id`
      AND NEW.`disc_kind` = 'dvd'
      AND source_detected_disc.`disc_kind` = NEW.`disc_kind`
      AND source_detected_disc.`fingerprint` = NEW.`fingerprint`
      AND NEW.`fingerprint` = committed_manifest.`image_fingerprint`
      AND NEW.`boundary_policy_version` = evidence_header.`boundary_policy_version`
      AND NEW.`boundary_reported_size_bytes` = evidence_header.`boundary_reported_size_bytes`
      AND NEW.`boundary_published_size_bytes` = evidence_header.`boundary_published_size_bytes`
      AND NEW.`size_bytes` = evidence_header.`boundary_published_size_bytes`
      AND source_job.`original_disc_archive_id` = NEW.`id`
      AND source_job.`detected_disc_id` = NEW.`detected_disc_id`
      AND source_job.`evidence_format` = evidence_header.`evidence_format`
      AND source_job.`status` = 'completed'
      AND (
        source_request.`detected_disc_id` = NEW.`detected_disc_id`
        OR (
          requested_detected_disc.`disc_kind` = 'dvd'
          AND requested_detected_disc.`status` = CASE
            WHEN source_request.`rearchive_source_archive_id` IS NULL
              THEN 'approved'
            ELSE 'archived'
          END
          AND NOT EXISTS (
            SELECT 1
            FROM `archive_jobs` AS request_attempt
            INNER JOIN `disc_inspections` AS request_attempt_inspection
              ON request_attempt_inspection.`id` = request_attempt.`disc_inspection_id`
            WHERE request_attempt.`archive_request_id` = source_request.`id`
              AND request_attempt_inspection.`total_bytes` IS NOT NULL
              AND request_attempt_inspection.`total_bytes` <> evidence_header.`boundary_reported_size_bytes`
          )
          AND (
            (
              source_request.`rearchive_source_archive_id` IS NULL
              AND json_valid(source_detected_disc.`scan_data`)
              AND json_extract(source_detected_disc.`scan_data`, '$.schemaVersion') = 2
              AND json_extract(source_detected_disc.`scan_data`, '$.contentId') = source_detected_disc.`fingerprint`
              AND requested_detected_disc.`fingerprint` = source_detected_disc.`fingerprint`
              AND json_valid(requested_detected_disc.`scan_data`)
              AND json_extract(requested_detected_disc.`scan_data`, '$.schemaVersion') = 2
              AND json_extract(requested_detected_disc.`scan_data`, '$.contentId') = source_detected_disc.`fingerprint`
            )
            OR (
              source_request.`rearchive_source_archive_id` IS NOT NULL
              AND NEW.`rearchive_source_archive_id` = source_request.`rearchive_source_archive_id`
            )
          )
        )
      )
      AND source_request.`evidence_format` = evidence_header.`evidence_format`
      AND source_request.`status` = 'fulfilled'
      AND source_inspection.`detected_disc_id` = NEW.`detected_disc_id`
      AND source_inspection.`status` = 'completed'
      AND source_inspection.`total_bytes` = evidence_header.`boundary_reported_size_bytes`
      AND (
        (json_array_length(committed_manifest.`unrecovered_source_ranges`) = 0
          AND NEW.`integrity` = 'clean_read'
          AND NEW.`integrity_policy_version` = evidence_header.`evidence_format`
          AND NEW.`bad_sector_count` = 0 AND NEW.`bad_area_count` = 0
          AND json(NEW.`bad_sector_ranges`) = json('[]')
          AND NEW.`bad_sector_counts_by_title` IS NULL)
        OR
        (json_array_length(committed_manifest.`unrecovered_source_ranges`) > 0
          AND NEW.`integrity` = 'incomplete_read'
          AND NEW.`integrity_policy_version` = evidence_header.`evidence_format`
          AND NEW.`bad_sector_count` = (SELECT sum(json_extract(source_range.`value`, '$.sectorCount')) FROM json_each(committed_manifest.`unrecovered_source_ranges`) AS source_range)
          AND NEW.`bad_area_count` = json_array_length(committed_manifest.`unrecovered_source_ranges`)
          AND json_valid(NEW.`bad_sector_ranges`)
          AND json_type(NEW.`bad_sector_ranges`) = 'array'
          AND json_array_length(NEW.`bad_sector_ranges`) = json_array_length(committed_manifest.`unrecovered_source_ranges`)
          AND NOT EXISTS (
            SELECT 1 FROM json_each(committed_manifest.`unrecovered_source_ranges`) AS source_range
            LEFT JOIN json_each(NEW.`bad_sector_ranges`) AS projected_range ON projected_range.`key` = source_range.`key`
            WHERE projected_range.`key` IS NULL
              OR json_type(projected_range.`value`) IS NOT 'object'
              OR (SELECT count(*) FROM json_each(projected_range.`value`)) <> 2
              OR json_extract(projected_range.`value`, '$.startLba') <> json_extract(source_range.`value`, '$.startLba')
              OR json_extract(projected_range.`value`, '$.sectorCount') <> json_extract(source_range.`value`, '$.sectorCount')
          )
          AND NEW.`bad_sector_counts_by_title` IS NULL)
      )
    )
  )
BEGIN SELECT RAISE(ABORT, 'Archive Integrity projection must match a committed DVD evidence manifest'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_archive_recovery_insert_guard`
BEFORE INSERT ON `archive_recoveries`
WHEN NOT EXISTS (
  SELECT 1 FROM `dvd_archive_evidence_headers` AS evidence_header
  INNER JOIN `dvd_archive_evidence_manifests` AS current_manifest ON current_manifest.`id` = evidence_header.`current_manifest_id`
  WHERE evidence_header.`original_disc_archive_id` = NEW.`original_disc_archive_id`
    AND ((json_array_length(current_manifest.`unrecovered_source_ranges`) = 0 AND NEW.`status` = 'completed') OR (json_array_length(current_manifest.`unrecovered_source_ranges`) > 0 AND NEW.`status` = 'eligible'))
)
BEGIN SELECT RAISE(ABORT, 'Archive Recovery status must match authoritative DVD evidence'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_archive_recovery_update_guard`
BEFORE UPDATE ON `archive_recoveries`
WHEN OLD.`id` IS NOT NEW.`id`
  OR OLD.`original_disc_archive_id` IS NOT NEW.`original_disc_archive_id`
  OR OLD.`created_at` IS NOT NEW.`created_at`
  OR NEW.`updated_at` < OLD.`updated_at`
  OR NOT EXISTS (
  SELECT 1 FROM `dvd_archive_evidence_headers` AS evidence_header
  INNER JOIN `dvd_archive_evidence_manifests` AS current_manifest ON current_manifest.`id` = evidence_header.`current_manifest_id`
  WHERE evidence_header.`original_disc_archive_id` = NEW.`original_disc_archive_id`
    AND ((json_array_length(current_manifest.`unrecovered_source_ranges`) = 0 AND NEW.`status` = 'completed') OR (json_array_length(current_manifest.`unrecovered_source_ranges`) > 0 AND NEW.`status` = 'eligible'))
)
BEGIN SELECT RAISE(ABORT, 'Archive Recovery identity is immutable and status must match authoritative DVD evidence'); END;
--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_archive_recovery_delete_guard`
BEFORE DELETE ON `archive_recoveries`
BEGIN SELECT RAISE(ABORT, 'Archive Recovery identity is immutable'); END;
