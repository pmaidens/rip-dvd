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
	CONSTRAINT "archive_recoveries_stop_check" CHECK(("status" = 'stopping' and "stop_operation_id" is not null and "stop_requested_at" is not null and "stopped_at" is null) or ("status" = 'stopped' and "stop_operation_id" is not null and "stop_requested_at" is not null and "stopped_at" is not null) or ("status" not in ('stopping', 'stopped') and "stopped_at" is null)),
	CONSTRAINT "archive_recoveries_fault_check" CHECK(("status" = 'faulted' and "fault_code" is not null) or ("status" <> 'faulted' and "fault_code" is null))
);
--> statement-breakpoint
INSERT INTO `__new_archive_recoveries`(
	`id`, `original_disc_archive_id`, `attempt_id`, `attempt_ordinal`, `status`,
	`stop_operation_id`, `stop_requested_at`, `stopped_at`, `fault_code`,
	`created_at`, `updated_at`
) SELECT
	`id`, `original_disc_archive_id`, 'archive-recovery-attempt-v1.' || `id`, 1,
	`status`, NULL, NULL, NULL, NULL, `created_at`, `updated_at`
FROM `archive_recoveries`;--> statement-breakpoint
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_archive_recovery_work_original_disc_archive_id_dvd_archive_evidence_headers_original_disc_archive_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `dvd_archive_evidence_headers`(`original_disc_archive_id`) ON DELETE RESTRICT,
	CONSTRAINT `archive_recovery_work_attempt_fk` FOREIGN KEY (`archive_recovery_id`,`original_disc_archive_id`,`attempt_id`) REFERENCES `archive_recoveries`(`id`,`original_disc_archive_id`,`attempt_id`) ON DELETE RESTRICT,
	CONSTRAINT "archive_recovery_work_id_not_null" CHECK("archive_recovery_id" is not null),
	CONSTRAINT "archive_recovery_work_status_check" CHECK("status" in ('requested', 'claimed')),
	CONSTRAINT "archive_recovery_work_claim_check" CHECK(("status" = 'requested' and "requested_at" is not null and "claimed_by" is null and "claim_token" is null and "claimed_at" is null) or ("status" = 'claimed' and "claimed_by" is not null and "claim_token" is not null and "claimed_at" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_archive_recovery_work`(
	`archive_recovery_id`, `original_disc_archive_id`, `attempt_id`, `status`,
	`verification_id`, `requested_at`, `claimed_by`, `claim_token`, `claimed_at`,
	`created_at`, `updated_at`
) SELECT
	`archive_recovery_id`, `original_disc_archive_id`,
	'archive-recovery-attempt-v1.' || `archive_recovery_id`, `status`, NULL,
	`requested_at`, `claimed_by`, `claim_token`, `claimed_at`, `created_at`,
	`updated_at`
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
