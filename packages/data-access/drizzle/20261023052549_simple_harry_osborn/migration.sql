ALTER TABLE `archive_recoveries` ADD `pause_reason` text;--> statement-breakpoint
ALTER TABLE `archive_recoveries` ADD `pass_history` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `archive_recovery_work` ADD `pass_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `archive_recovery_work` ADD `pass_direction` text DEFAULT 'forward' NOT NULL;--> statement-breakpoint
ALTER TABLE `archive_recovery_work` ADD `pass_started_at` integer;--> statement-breakpoint
ALTER TABLE `archive_recovery_work` ADD `pass_initial_unrecovered_sector_count` integer;--> statement-breakpoint
ALTER TABLE `archive_recovery_work` ADD `pass_recovered_sector_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_archive_recoveries` (
	`id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`attempt_ordinal` integer NOT NULL,
	`status` text NOT NULL,
	`pause_reason` text,
	`pass_history` text DEFAULT '[]' NOT NULL,
	`stop_operation_id` text,
	`stop_requested_at` integer,
	`stopped_at` integer,
	`fault_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_archive_recoveries_original_disc_archive_id_dvd_archive_evidence_headers_original_disc_archive_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `dvd_archive_evidence_headers`(`original_disc_archive_id`) ON DELETE RESTRICT,
	CONSTRAINT "archive_recoveries_id_not_null" CHECK("id" is not null),
	CONSTRAINT "archive_recoveries_attempt_ordinal_check" CHECK(typeof("attempt_ordinal") = 'integer' and "attempt_ordinal" > 0),
	CONSTRAINT "archive_recoveries_status_check" CHECK("status" in ('eligible', 'running', 'paused', 'stopping', 'stopped', 'completed', 'faulted')),
	CONSTRAINT "archive_recoveries_pause_check" CHECK(("status" = 'paused' and "pause_reason" in ('no_progress')) or ("status" <> 'paused' and "pause_reason" is null)),
	CONSTRAINT "archive_recoveries_pass_history_check" CHECK(json_valid("pass_history") and json_type("pass_history") = 'array' and json_array_length("pass_history") <= 16),
	CONSTRAINT "archive_recoveries_stop_check" CHECK(("status" = 'stopping' and "stop_operation_id" is not null and "stop_requested_at" is not null and "stopped_at" is null) or ("status" = 'stopped' and "stop_operation_id" is not null and "stop_requested_at" is not null and "stopped_at" is not null) or ("status" = 'faulted' and "stopped_at" is null and (("stop_operation_id" is null and "stop_requested_at" is null) or ("stop_operation_id" is not null and "stop_requested_at" is not null))) or ("status" not in ('stopping', 'stopped', 'faulted') and "stop_operation_id" is null and "stop_requested_at" is null and "stopped_at" is null)),
	CONSTRAINT "archive_recoveries_fault_check" CHECK(("status" = 'faulted' and "fault_code" in ('CONSISTENCY_FAULT', 'WRITER_NOT_QUIESCENT', 'DISC_VERIFICATION_STALE', 'STORAGE_UNSUPPORTED', 'JOURNAL_CAPACITY_INSUFFICIENT', 'JOURNAL_RESERVATION_FAILED', 'JOURNAL_SYNC_FAILED', 'IMAGE_WRITE_FAILED', 'IMAGE_SYNC_FAILED', 'CHECKPOINT_CAPACITY_EXHAUSTED', 'CHECKPOINT_SYNC_FAILED', 'CHECKPOINT_REPLACEMENT_FAILED', 'SOURCE_CHANGED', 'SOURCE_OBSERVATION_FAILED', 'SOURCE_READ_FAILED', 'SOURCE_NOT_READY', 'SOURCE_UNIT_ATTENTION', 'SOURCE_HARDWARE_ERROR', 'SOURCE_TRANSPORT_ERROR', 'SOURCE_PROTECTION_ERROR', 'SOURCE_OUT_OF_RANGE', 'SOURCE_READ_UNCLASSIFIED')) or ("status" <> 'faulted' and "fault_code" is null))
);
--> statement-breakpoint
INSERT INTO `__new_archive_recoveries`(`id`, `original_disc_archive_id`, `attempt_id`, `attempt_ordinal`, `status`, `stop_operation_id`, `stop_requested_at`, `stopped_at`, `fault_code`, `created_at`, `updated_at`) SELECT `id`, `original_disc_archive_id`, `attempt_id`, `attempt_ordinal`, `status`, `stop_operation_id`, `stop_requested_at`, `stopped_at`, `fault_code`, `created_at`, `updated_at` FROM `archive_recoveries`;--> statement-breakpoint
DROP TABLE `archive_recoveries`;--> statement-breakpoint
ALTER TABLE `__new_archive_recoveries` RENAME TO `archive_recoveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_archive_recovery_work` (
	`archive_recovery_id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL UNIQUE,
	`attempt_id` text NOT NULL,
	`status` text NOT NULL,
	`verification_id` text,
	`requested_at` integer,
	`claimed_by` text,
	`claim_token` text,
	`claimed_at` integer,
	`pass_number` integer DEFAULT 1 NOT NULL,
	`pass_direction` text DEFAULT 'forward' NOT NULL,
	`pass_started_at` integer,
	`pass_initial_unrecovered_sector_count` integer,
	`pass_recovered_sector_count` integer DEFAULT 0 NOT NULL,
	`pass_cursor_lba` integer,
	`admitted_device_path` text,
	`admitted_device_id` text,
	`admitted_device_inode` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_archive_recovery_work_original_disc_archive_id_dvd_archive_evidence_headers_original_disc_archive_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `dvd_archive_evidence_headers`(`original_disc_archive_id`) ON DELETE RESTRICT,
	CONSTRAINT `archive_recovery_work_attempt_fk` FOREIGN KEY (`archive_recovery_id`,`original_disc_archive_id`,`attempt_id`) REFERENCES `archive_recoveries`(`id`,`original_disc_archive_id`,`attempt_id`) ON DELETE RESTRICT,
	CONSTRAINT "archive_recovery_work_id_not_null" CHECK("archive_recovery_id" is not null),
	CONSTRAINT "archive_recovery_work_status_check" CHECK("status" in ('requested', 'claimed')),
	CONSTRAINT "archive_recovery_work_claim_check" CHECK(("status" = 'requested' and "requested_at" is not null and "claimed_by" is null and "claim_token" is null and "claimed_at" is null) or ("status" = 'claimed' and "claimed_by" is not null and "claim_token" is not null and "claimed_at" is not null)),
	CONSTRAINT "archive_recovery_work_cursor_check" CHECK("pass_cursor_lba" is null or (typeof("pass_cursor_lba") = 'integer' and "pass_cursor_lba" >= 0)),
	CONSTRAINT "archive_recovery_work_pass_check" CHECK(typeof("pass_number") = 'integer' and "pass_number" > 0 and "pass_direction" in ('forward', 'reverse') and (("pass_started_at" is null and "pass_initial_unrecovered_sector_count" is null and "pass_recovered_sector_count" = 0 and "pass_cursor_lba" is null) or ("pass_started_at" is not null and typeof("pass_initial_unrecovered_sector_count") = 'integer' and "pass_initial_unrecovered_sector_count" > 0 and typeof("pass_recovered_sector_count") = 'integer' and "pass_recovered_sector_count" between 0 and "pass_initial_unrecovered_sector_count"))),
	CONSTRAINT "archive_recovery_work_device_identity_check" CHECK(("admitted_device_path" is null and "admitted_device_id" is null and "admitted_device_inode" is null) or ("status" = 'claimed' and "admitted_device_path" is not null and length("admitted_device_path") > 0 and "admitted_device_id" is not null and length("admitted_device_id") > 0 and "admitted_device_inode" is not null and length("admitted_device_inode") > 0))
);
--> statement-breakpoint
INSERT INTO `__new_archive_recovery_work`(
	`archive_recovery_id`, `original_disc_archive_id`, `attempt_id`, `status`,
	`verification_id`, `requested_at`, `claimed_by`, `claim_token`, `claimed_at`,
	`pass_number`, `pass_direction`, `pass_started_at`,
	`pass_initial_unrecovered_sector_count`, `pass_recovered_sector_count`,
	`pass_cursor_lba`, `admitted_device_path`, `admitted_device_id`,
	`admitted_device_inode`, `created_at`, `updated_at`
) SELECT
	`archive_recovery_id`, `original_disc_archive_id`, `attempt_id`, `status`,
	`verification_id`, `requested_at`, `claimed_by`, `claim_token`, `claimed_at`,
	1, 'forward',
	CASE WHEN `status` = 'claimed' OR `pass_cursor_lba` IS NOT NULL
		THEN COALESCE(`claimed_at`, `requested_at`, `created_at`) ELSE NULL END,
	CASE WHEN `status` = 'claimed' OR `pass_cursor_lba` IS NOT NULL THEN
		(SELECT COALESCE(SUM(CAST(json_extract(r.value, '$.sectorCount') AS integer)), 0)
		 FROM `dvd_archive_evidence_headers` h
		 JOIN `dvd_archive_evidence_manifests` m ON m.`id` = h.`current_manifest_id`
		 JOIN json_each(m.`unrecovered_source_ranges`) r
		 WHERE h.`original_disc_archive_id` = `archive_recovery_work`.`original_disc_archive_id`)
		+
		(SELECT COALESCE(SUM(`sector_count`), 0)
		 FROM `dvd_archive_recovery_reads`
		 WHERE `original_disc_archive_id` = `archive_recovery_work`.`original_disc_archive_id`
		   AND `outcome` = 'recovered'
		   AND `created_at` >= `archive_recovery_work`.`created_at`)
		ELSE NULL END,
	CASE WHEN `status` = 'claimed' OR `pass_cursor_lba` IS NOT NULL THEN
		(SELECT COALESCE(SUM(`sector_count`), 0)
		 FROM `dvd_archive_recovery_reads`
		 WHERE `original_disc_archive_id` = `archive_recovery_work`.`original_disc_archive_id`
		   AND `outcome` = 'recovered'
		   AND `created_at` >= `archive_recovery_work`.`created_at`)
		ELSE 0 END,
	`pass_cursor_lba`, `admitted_device_path`, `admitted_device_id`,
	`admitted_device_inode`, `created_at`, `updated_at`
FROM `archive_recovery_work`;--> statement-breakpoint
DROP TABLE `archive_recovery_work`;--> statement-breakpoint
ALTER TABLE `__new_archive_recovery_work` RENAME TO `archive_recovery_work`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `archive_recoveries_archive_unique` ON `archive_recoveries` (`original_disc_archive_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `archive_recoveries_identity_unique` ON `archive_recoveries` (`id`,`original_disc_archive_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `archive_recoveries_attempt_unique` ON `archive_recoveries` (`id`,`original_disc_archive_id`,`attempt_id`);--> statement-breakpoint
CREATE INDEX `archive_recovery_work_queue_idx` ON `archive_recovery_work` (`status`,`requested_at`,`created_at`);--> statement-breakpoint
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
        (NEW.`status` IN ('stopping', 'stopped', 'faulted'))
        OR
        (NEW.`status` = 'running' AND EXISTS (
          SELECT 1 FROM `archive_recovery_work` AS recovery_work
          WHERE recovery_work.`archive_recovery_id` = NEW.`id`
            AND recovery_work.`attempt_id` = NEW.`attempt_id`
            AND recovery_work.`status` = 'claimed'
        ))
        OR
        (json_array_length(current_manifest.`unrecovered_source_ranges`) = 0
          AND NEW.`status` = 'completed')
        OR
        (json_array_length(current_manifest.`unrecovered_source_ranges`) > 0
          AND NEW.`status` IN ('eligible', 'paused'))
      )
  )
BEGIN SELECT RAISE(ABORT, 'Archive Recovery identity is immutable and status must match authoritative DVD evidence'); END;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_archive_recovery_delete_guard`
BEFORE DELETE ON `archive_recoveries`
BEGIN SELECT RAISE(ABORT, 'Archive Recovery identity is immutable'); END;
