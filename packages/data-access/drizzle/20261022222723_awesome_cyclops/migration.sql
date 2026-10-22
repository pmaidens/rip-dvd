ALTER TABLE `dvd_disc_verifications` ADD `archive_recovery_attempt_id` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_dvd_disc_verifications` (
	`id` text PRIMARY KEY,
	`archive_recovery_id` text NOT NULL,
	`archive_recovery_attempt_id` text,
	`attempt_ordinal` integer NOT NULL,
	`original_disc_archive_id` text NOT NULL,
	`disc_inspection_id` text NOT NULL,
	`detected_disc_id` text NOT NULL,
	`media_generation` text NOT NULL,
	`source_metadata_fingerprint` text NOT NULL,
	`observed_metadata_fingerprint` text NOT NULL,
	`checkpoint_revision` integer NOT NULL,
	`checkpoint_digest` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text,
	`reasons` text NOT NULL,
	`findings` text NOT NULL,
	`budget_exhausted` integer DEFAULT false NOT NULL,
	`worker_execution_id` text,
	`claim_token` text,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`failure_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_disc_verifications_archive_recovery_id_archive_recoveries_id_fk` FOREIGN KEY (`archive_recovery_id`) REFERENCES `archive_recoveries`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_disc_verifications_original_disc_archive_id_dvd_archive_evidence_headers_original_disc_archive_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `dvd_archive_evidence_headers`(`original_disc_archive_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_disc_verifications_disc_inspection_id_disc_inspections_id_fk` FOREIGN KEY (`disc_inspection_id`) REFERENCES `disc_inspections`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_disc_verifications_detected_disc_id_detected_discs_id_fk` FOREIGN KEY (`detected_disc_id`) REFERENCES `detected_discs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_disc_verifications_id_not_null" CHECK("id" is not null),
	CONSTRAINT "dvd_disc_verifications_status_check" CHECK("status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "dvd_disc_verifications_checkpoint_check" CHECK(typeof("checkpoint_revision") = 'integer' and "checkpoint_revision" > 0 and length("checkpoint_digest") = 64 and "checkpoint_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "dvd_disc_verifications_attempt_check" CHECK(typeof("attempt_ordinal") = 'integer' and "attempt_ordinal" > 0 and ("archive_recovery_attempt_id" is null or length("archive_recovery_attempt_id") > 0)),
	CONSTRAINT "dvd_disc_verifications_json_check" CHECK(json_valid("reasons") and json_type("reasons") = 'array' and json_valid("findings") and json_type("findings") = 'array'),
	CONSTRAINT "dvd_disc_verifications_result_check" CHECK(("status" in ('queued', 'running') and "outcome" is null and "completed_at" is null and "failure_code" is null) or ("status" = 'completed' and "outcome" in ('match', 'mismatch', 'inconclusive') and "completed_at" is not null and "failure_code" is null) or ("status" = 'failed' and "outcome" is null and "completed_at" is not null and "failure_code" = 'DISC_VERIFICATION_UNAVAILABLE')),
	CONSTRAINT "dvd_disc_verifications_claim_check" CHECK(("status" = 'running' and "claim_token" is not null and "claimed_at" is not null and "worker_execution_id" is not null and "started_at" is not null) or ("status" <> 'running' and "claim_token" is null and "claimed_at" is null))
);
--> statement-breakpoint
INSERT INTO `__new_dvd_disc_verifications`(`id`, `archive_recovery_id`, `attempt_ordinal`, `original_disc_archive_id`, `disc_inspection_id`, `detected_disc_id`, `media_generation`, `source_metadata_fingerprint`, `observed_metadata_fingerprint`, `checkpoint_revision`, `checkpoint_digest`, `status`, `outcome`, `reasons`, `findings`, `budget_exhausted`, `worker_execution_id`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `failure_code`, `created_at`, `updated_at`) SELECT `id`, `archive_recovery_id`, `attempt_ordinal`, `original_disc_archive_id`, `disc_inspection_id`, `detected_disc_id`, `media_generation`, `source_metadata_fingerprint`, `observed_metadata_fingerprint`, `checkpoint_revision`, `checkpoint_digest`, `status`, `outcome`, `reasons`, `findings`, `budget_exhausted`, `worker_execution_id`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `failure_code`, `created_at`, `updated_at` FROM `dvd_disc_verifications`;--> statement-breakpoint
DROP TABLE `dvd_disc_verifications`;--> statement-breakpoint
ALTER TABLE `__new_dvd_disc_verifications` RENAME TO `dvd_disc_verifications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_dvd_recovery_reconciliations` (
	`id` text PRIMARY KEY,
	`archive_recovery_id` text NOT NULL,
	`attempt_ordinal` integer NOT NULL,
	`original_disc_archive_id` text NOT NULL,
	`status` text NOT NULL,
	`phase` text NOT NULL,
	`outcome` text,
	`evidence` text,
	`failure_code` text,
	`worker_execution_id` text,
	`claim_token` text,
	`claimed_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `dvd_recovery_reconciliations_recovery_archive_fk` FOREIGN KEY (`archive_recovery_id`,`original_disc_archive_id`) REFERENCES `archive_recoveries`(`id`,`original_disc_archive_id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_recovery_reconciliations_id_not_null" CHECK("id" is not null),
	CONSTRAINT "dvd_recovery_reconciliations_attempt_ordinal_check" CHECK(typeof("attempt_ordinal") = 'integer' and "attempt_ordinal" > 0),
	CONSTRAINT "dvd_recovery_reconciliations_status_check" CHECK("status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "dvd_recovery_reconciliations_phase_check" CHECK("phase" in ('queued', 'examining', 'rolling_back', 'projecting', 'cleaning_up', 'completed')),
	CONSTRAINT "dvd_recovery_reconciliations_result_check" CHECK(("status" in ('queued', 'running') and "outcome" is null and "evidence" is null and "failure_code" is null and "completed_at" is null) or ("status" = 'completed' and "phase" = 'completed' and "outcome" in ('already_consistent', 'rolled_back', 'rolled_forward', 'cleaned_up') and "evidence" is not null and json_valid("evidence") and json_type("evidence") = 'object' and "failure_code" is null and "completed_at" is not null) or ("status" = 'failed' and "phase" = 'completed' and "outcome" is null and "evidence" is null and "failure_code" in ('CONSISTENCY_FAULT', 'WRITER_NOT_QUIESCENT', 'STORAGE_UNSUPPORTED') and "completed_at" is not null)),
	CONSTRAINT "dvd_recovery_reconciliations_claim_check" CHECK(("status" = 'running' and "worker_execution_id" is not null and "claim_token" is not null and "claimed_at" is not null and "started_at" is not null and "phase" <> 'queued' and "phase" <> 'completed') or ("status" <> 'running' and "claim_token" is null and "claimed_at" is null))
);
--> statement-breakpoint
INSERT INTO `__new_dvd_recovery_reconciliations`(`id`, `archive_recovery_id`, `attempt_ordinal`, `original_disc_archive_id`, `status`, `phase`, `outcome`, `evidence`, `failure_code`, `worker_execution_id`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `created_at`, `updated_at`) SELECT `id`, `archive_recovery_id`, `attempt_ordinal`, `original_disc_archive_id`, `status`, `phase`, `outcome`, `evidence`, `failure_code`, `worker_execution_id`, `claim_token`, `claimed_at`, `started_at`, `completed_at`, `created_at`, `updated_at` FROM `dvd_recovery_reconciliations`;--> statement-breakpoint
DROP TABLE `dvd_recovery_reconciliations`;--> statement-breakpoint
ALTER TABLE `__new_dvd_recovery_reconciliations` RENAME TO `dvd_recovery_reconciliations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_archive_recoveries` (
	`id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`attempt_ordinal` integer NOT NULL,
	`status` text NOT NULL,
	`stop_operation_id` text,
	`stop_requested_at` integer,
	`stopped_at` integer,
	`fault_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_archive_recoveries_original_disc_archive_id_dvd_archive_evidence_headers_original_disc_archive_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `dvd_archive_evidence_headers`(`original_disc_archive_id`) ON DELETE RESTRICT,
	CONSTRAINT "archive_recoveries_id_not_null" CHECK("id" is not null),
	CONSTRAINT "archive_recoveries_attempt_ordinal_check" CHECK(typeof("attempt_ordinal") = 'integer' and "attempt_ordinal" > 0),
	CONSTRAINT "archive_recoveries_status_check" CHECK("status" in ('eligible', 'running', 'stopping', 'stopped', 'completed', 'faulted')),
	CONSTRAINT "archive_recoveries_stop_check" CHECK(("status" = 'stopping' and "stop_operation_id" is not null and "stop_requested_at" is not null and "stopped_at" is null) or ("status" = 'stopped' and "stop_operation_id" is not null and "stop_requested_at" is not null and "stopped_at" is not null) or ("status" not in ('stopping', 'stopped') and "stop_operation_id" is null and "stop_requested_at" is null and "stopped_at" is null)),
	CONSTRAINT "archive_recoveries_fault_check" CHECK(("status" = 'faulted' and "fault_code" in ('CONSISTENCY_FAULT', 'WRITER_NOT_QUIESCENT', 'DISC_VERIFICATION_STALE', 'STORAGE_UNSUPPORTED', 'JOURNAL_CAPACITY_INSUFFICIENT', 'JOURNAL_RESERVATION_FAILED', 'JOURNAL_SYNC_FAILED', 'IMAGE_WRITE_FAILED', 'IMAGE_SYNC_FAILED', 'CHECKPOINT_CAPACITY_EXHAUSTED', 'CHECKPOINT_SYNC_FAILED', 'CHECKPOINT_REPLACEMENT_FAILED', 'SOURCE_CHANGED', 'SOURCE_OBSERVATION_FAILED', 'SOURCE_READ_FAILED', 'SOURCE_NOT_READY', 'SOURCE_UNIT_ATTENTION', 'SOURCE_HARDWARE_ERROR', 'SOURCE_TRANSPORT_ERROR', 'SOURCE_PROTECTION_ERROR', 'SOURCE_OUT_OF_RANGE', 'SOURCE_READ_UNCLASSIFIED')) or ("status" <> 'faulted' and "fault_code" is null))
);
--> statement-breakpoint
INSERT INTO `__new_archive_recoveries`(`id`, `original_disc_archive_id`, `attempt_id`, `attempt_ordinal`, `status`, `stop_operation_id`, `stop_requested_at`, `stopped_at`, `fault_code`, `created_at`, `updated_at`) SELECT `id`, `original_disc_archive_id`, `attempt_id`, `attempt_ordinal`, `status`, `stop_operation_id`, `stop_requested_at`, `stopped_at`, `fault_code`, `created_at`, `updated_at` FROM `archive_recoveries`;--> statement-breakpoint
DROP TABLE `archive_recoveries`;--> statement-breakpoint
ALTER TABLE `__new_archive_recoveries` RENAME TO `archive_recoveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_disc_verifications_recovery_attempt_unique` ON `dvd_disc_verifications` (`archive_recovery_id`,`attempt_ordinal`);--> statement-breakpoint
CREATE INDEX `dvd_disc_verifications_status_created_idx` ON `dvd_disc_verifications` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_recovery_reconciliations_active_unique` ON `dvd_recovery_reconciliations` (`archive_recovery_id`) WHERE "dvd_recovery_reconciliations"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX `dvd_recovery_reconciliations_attempt_unique` ON `dvd_recovery_reconciliations` (`archive_recovery_id`,`attempt_ordinal`);--> statement-breakpoint
CREATE INDEX `dvd_recovery_reconciliations_status_created_idx` ON `dvd_recovery_reconciliations` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `dvd_recovery_reconciliations_recovery_created_idx` ON `dvd_recovery_reconciliations` (`archive_recovery_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `archive_recoveries_archive_unique` ON `archive_recoveries` (`original_disc_archive_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `archive_recoveries_identity_unique` ON `archive_recoveries` (`id`,`original_disc_archive_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `archive_recoveries_attempt_unique` ON `archive_recoveries` (`id`,`original_disc_archive_id`,`attempt_id`);--> statement-breakpoint
DROP TRIGGER IF EXISTS `dvd_evidence_manifest_insert_guard`;--> statement-breakpoint
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
          AND (recovery_read.`outcome` = 'recovered' OR json_extract(previous_range.`value`, '$.classification') IN ('skipped_untested', 'individually_failed'))
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
CREATE TRIGGER `dvd_evidence_archive_recovery_insert_guard`
BEFORE INSERT ON `archive_recoveries`
WHEN NOT EXISTS (
  SELECT 1 FROM `dvd_archive_evidence_headers` AS evidence_header
  INNER JOIN `dvd_archive_evidence_manifests` AS current_manifest
    ON current_manifest.`id` = evidence_header.`current_manifest_id`
  WHERE evidence_header.`original_disc_archive_id` = NEW.`original_disc_archive_id`
    AND (
      (json_array_length(current_manifest.`unrecovered_source_ranges`) = 0
        AND NEW.`status` = 'completed')
      OR
      (json_array_length(current_manifest.`unrecovered_source_ranges`) > 0
        AND NEW.`status` = 'eligible')
    )
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
    INNER JOIN `dvd_archive_evidence_manifests` AS current_manifest
      ON current_manifest.`id` = evidence_header.`current_manifest_id`
    WHERE evidence_header.`original_disc_archive_id` = NEW.`original_disc_archive_id`
      AND (
        (NEW.`status` IN ('stopping', 'stopped'))
        OR
        (json_array_length(current_manifest.`unrecovered_source_ranges`) = 0
          AND NEW.`status` = 'completed')
        OR
        (json_array_length(current_manifest.`unrecovered_source_ranges`) > 0
          AND NEW.`status` IN ('eligible', 'running', 'faulted'))
      )
  )
BEGIN SELECT RAISE(ABORT, 'Archive Recovery identity is immutable and status must match authoritative DVD evidence'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_archive_recovery_delete_guard`
BEFORE DELETE ON `archive_recoveries`
BEGIN SELECT RAISE(ABORT, 'Archive Recovery identity is immutable'); END;
