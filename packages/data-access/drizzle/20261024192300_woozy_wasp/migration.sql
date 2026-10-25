ALTER TABLE `archive_recovery_work` ADD `pass_started_manifest_revision` integer;--> statement-breakpoint
ALTER TABLE `archive_recovery_work` ADD `pass_observation_count` integer;--> statement-breakpoint
ALTER TABLE `archive_recovery_work` ADD `pass_positive_interval_count` integer;--> statement-breakpoint
ALTER TABLE `archive_recovery_work` ADD `pass_minimum_interval_ms` integer;--> statement-breakpoint
ALTER TABLE `archive_recovery_work` ADD `pass_maximum_interval_ms` integer;--> statement-breakpoint
ALTER TABLE `archive_recovery_work` ADD `pass_last_observed_at` integer;--> statement-breakpoint
ALTER TABLE `dvd_archive_recovery_reads` ADD `from_classification` text DEFAULT 'individually_failed' NOT NULL;--> statement-breakpoint
ALTER TABLE `dvd_archive_recovery_reads` ADD `meaningful_transition` integer DEFAULT true NOT NULL;--> statement-breakpoint
DROP TRIGGER `dvd_evidence_recovery_read_insert_guard`;--> statement-breakpoint
DROP TRIGGER `dvd_evidence_recovery_read_update_guard`;--> statement-breakpoint
UPDATE `dvd_archive_recovery_reads`
SET `from_classification` = coalesce((
  SELECT json_extract(source_range.`value`, '$.classification')
  FROM `dvd_archive_evidence_manifests` AS source_manifest,
    json_each(source_manifest.`unrecovered_source_ranges`) AS source_range
  WHERE source_manifest.`id` = `dvd_archive_recovery_reads`.`from_manifest_id`
    AND `dvd_archive_recovery_reads`.`start_lba` >=
      json_extract(source_range.`value`, '$.startLba')
    AND `dvd_archive_recovery_reads`.`start_lba` <
      json_extract(source_range.`value`, '$.startLba') +
        json_extract(source_range.`value`, '$.sectorCount')
), 'individually_failed');--> statement-breakpoint
UPDATE `dvd_archive_recovery_reads`
SET `meaningful_transition` = CASE
  WHEN `outcome` = 'recovered' OR `from_classification` = 'skipped_untested'
  THEN 1
  WHEN EXISTS (
    SELECT 1
    FROM `dvd_archive_evidence_manifests` AS source_manifest,
      json_each(source_manifest.`unrecovered_source_ranges`) AS source_range
    WHERE source_manifest.`id` = `dvd_archive_recovery_reads`.`from_manifest_id`
      AND `dvd_archive_recovery_reads`.`start_lba` >=
        json_extract(source_range.`value`, '$.startLba')
      AND `dvd_archive_recovery_reads`.`start_lba` <
        json_extract(source_range.`value`, '$.startLba') +
          json_extract(source_range.`value`, '$.sectorCount')
  ) THEN 0
  ELSE 1
END;--> statement-breakpoint
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
    AND NEW.`from_classification` = json_extract(source_range.`value`, '$.classification')
    AND NEW.`meaningful_transition` = CASE
      WHEN NEW.`outcome` = 'recovered' OR json_extract(source_range.`value`, '$.classification') = 'skipped_untested'
      THEN 1 ELSE 0
    END
)
BEGIN SELECT RAISE(ABORT, 'DVD recovery read must be a one-sector read of the current unrecovered manifest'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_recovery_read_update_guard`
BEFORE UPDATE ON `dvd_archive_recovery_reads`
BEGIN SELECT RAISE(ABORT, 'DVD recovery read evidence is immutable'); END;--> statement-breakpoint
CREATE INDEX `dvd_archive_recovery_reads_archive_revision_idx` ON `dvd_archive_recovery_reads` (`original_disc_archive_id`,`from_manifest_revision`);--> statement-breakpoint
CREATE INDEX `dvd_archive_recovery_reads_archive_transition_revision_idx` ON `dvd_archive_recovery_reads` (`original_disc_archive_id`,`meaningful_transition`,`from_manifest_revision`);
