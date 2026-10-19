DROP TRIGGER `dvd_evidence_archive_job_update_guard`;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_archive_job_update_guard`
BEFORE UPDATE ON `archive_jobs`
WHEN NOT (
  OLD.`evidence_format` = 'dvd-recovery-evidence-v1'
  AND OLD.`status` = 'running' AND NEW.`status` = 'completed'
  AND OLD.`original_disc_archive_id` IS NULL AND NEW.`original_disc_archive_id` IS NOT NULL
  AND OLD.`completed_at` IS NULL AND NEW.`completed_at` = NEW.`updated_at`
  AND NEW.`updated_at` >= OLD.`updated_at` AND NEW.`error_message` IS NULL
  AND NEW.`progress_phase` = 'finalizing' AND NEW.`progress_percent` = 100
  AND NEW.`progress_eta_seconds` IS NULL AND NEW.`last_progress_at` = NEW.`updated_at`
  AND EXISTS (
    SELECT 1 FROM `original_disc_archives` AS a
    INNER JOIN `dvd_archive_evidence_manifests` AS m ON m.`original_disc_archive_id` = a.`id`
    INNER JOIN `archive_requests` AS r ON r.`id` = NEW.`archive_request_id`
    INNER JOIN `disc_inspections` AS i ON i.`id` = NEW.`disc_inspection_id`
    WHERE a.`id` = NEW.`original_disc_archive_id` AND a.`detected_disc_id` = NEW.`detected_disc_id`
      AND a.`disc_kind` = 'dvd' AND a.`integrity` = 'unknown'
      AND m.`revision` = 1 AND m.`evidence_format` = NEW.`evidence_format`
      AND m.`image_fingerprint` = a.`fingerprint`
      AND m.`boundary_published_size_bytes` = a.`size_bytes`
      AND NEW.`progress_bytes` = a.`size_bytes`
      AND r.`evidence_format` = NEW.`evidence_format` AND r.`status` = 'running'
      AND i.`detected_disc_id` = a.`detected_disc_id` AND i.`status` = 'completed'
      AND i.`total_bytes` = m.`boundary_reported_size_bytes`
  )
  AND NEW.`id` IS OLD.`id`
  AND NEW.`archive_request_id` IS OLD.`archive_request_id`
  AND NEW.`disc_inspection_id` IS OLD.`disc_inspection_id`
  AND NEW.`detected_disc_id` IS OLD.`detected_disc_id`
  AND NEW.`evidence_format` IS OLD.`evidence_format`
  AND NEW.`attempt_ordinal` IS OLD.`attempt_ordinal`
  AND NEW.`priority` IS OLD.`priority`
  AND NEW.`claimed_by` IS OLD.`claimed_by`
  AND NEW.`claim_token` IS OLD.`claim_token`
  AND NEW.`claimed_at` IS OLD.`claimed_at`
  AND NEW.`started_at` IS OLD.`started_at`
  AND NEW.`created_at` IS OLD.`created_at`
  AND NEW.`failure_detail_version` IS OLD.`failure_detail_version`
  AND NEW.`read_failure_stage` IS OLD.`read_failure_stage`
  AND NEW.`read_failure_category` IS OLD.`read_failure_category`
  AND NEW.`read_failure_classifier_version` IS OLD.`read_failure_classifier_version`
  AND NEW.`read_failure_lba` IS OLD.`read_failure_lba`
  AND NEW.`read_failure_requested_block_count` IS OLD.`read_failure_requested_block_count`
  AND NEW.`read_failure_retry_count` IS OLD.`read_failure_retry_count`
  AND NEW.`read_failure_scsi_status` IS OLD.`read_failure_scsi_status`
  AND NEW.`read_failure_host_status` IS OLD.`read_failure_host_status`
  AND NEW.`read_failure_driver_status` IS OLD.`read_failure_driver_status`
  AND NEW.`read_failure_sense_key` IS OLD.`read_failure_sense_key`
  AND NEW.`read_failure_asc` IS OLD.`read_failure_asc`
  AND NEW.`read_failure_ascq` IS OLD.`read_failure_ascq`
)
BEGIN
  SELECT CASE
    WHEN (
      OLD.`evidence_format` = 'dvd-recovery-evidence-v1'
      OR NEW.`evidence_format` = 'dvd-recovery-evidence-v1'
    )
      AND NOT (
        OLD.`evidence_format` = 'dvd-recovery-evidence-v1'
        AND NEW.`evidence_format` = OLD.`evidence_format`
        AND OLD.`status` = 'running'
        AND NEW.`status` = 'aborted'
        AND NEW.`id` = OLD.`id`
        AND NEW.`archive_request_id` = OLD.`archive_request_id`
        AND NEW.`disc_inspection_id` IS OLD.`disc_inspection_id`
        AND NEW.`detected_disc_id` = OLD.`detected_disc_id`
        AND NEW.`original_disc_archive_id` IS OLD.`original_disc_archive_id`
        AND NEW.`attempt_ordinal` = OLD.`attempt_ordinal`
        AND NEW.`priority` = OLD.`priority`
        AND NEW.`progress_phase` = OLD.`progress_phase`
        AND NEW.`progress_percent` = OLD.`progress_percent`
        AND NEW.`progress_bytes` = OLD.`progress_bytes`
        AND NEW.`progress_eta_seconds` IS OLD.`progress_eta_seconds`
        AND NEW.`last_progress_at` = OLD.`last_progress_at`
        AND NEW.`claimed_by` IS OLD.`claimed_by`
        AND NEW.`claim_token` IS OLD.`claim_token`
        AND NEW.`claimed_at` IS OLD.`claimed_at`
        AND NEW.`started_at` IS OLD.`started_at`
        AND OLD.`completed_at` IS NULL
        AND NEW.`completed_at` = NEW.`updated_at`
        AND typeof(NEW.`error_message`) = 'text'
        AND length(NEW.`error_message`) BETWEEN 1 AND 500
        AND NEW.`failure_detail_version` IS OLD.`failure_detail_version`
        AND NEW.`read_failure_stage` IS OLD.`read_failure_stage`
        AND NEW.`read_failure_category` IS OLD.`read_failure_category`
        AND NEW.`read_failure_classifier_version`
          IS OLD.`read_failure_classifier_version`
        AND NEW.`read_failure_lba` IS OLD.`read_failure_lba`
        AND NEW.`read_failure_requested_block_count`
          IS OLD.`read_failure_requested_block_count`
        AND NEW.`read_failure_retry_count` IS OLD.`read_failure_retry_count`
        AND NEW.`read_failure_scsi_status` IS OLD.`read_failure_scsi_status`
        AND NEW.`read_failure_host_status` IS OLD.`read_failure_host_status`
        AND NEW.`read_failure_driver_status` IS OLD.`read_failure_driver_status`
        AND NEW.`read_failure_sense_key` IS OLD.`read_failure_sense_key`
        AND NEW.`read_failure_asc` IS OLD.`read_failure_asc`
        AND NEW.`read_failure_ascq` IS OLD.`read_failure_ascq`
        AND NEW.`created_at` = OLD.`created_at`
        AND NEW.`updated_at` >= OLD.`updated_at`
        AND EXISTS (
          SELECT 1
          FROM `archive_requests`
          WHERE `id` = OLD.`archive_request_id`
            AND `status` = 'cancellation_requested'
            AND `evidence_format` = OLD.`evidence_format`
        )
      )
    THEN RAISE(
      ABORT,
      'New-format DVD Archive Job admission is closed until the recovery and encoding workflow is complete.'
    )
    WHEN NEW.`evidence_format` IS NOT (
      SELECT `evidence_format`
      FROM `archive_requests`
      WHERE `id` = NEW.`archive_request_id`
    )
    THEN RAISE(
      ABORT,
      'Archive Job evidence format must match its Archive Request'
    )
  END;
END;--> statement-breakpoint
DROP TRIGGER `dvd_evidence_archive_request_update_guard`;--> statement-breakpoint
CREATE TRIGGER `dvd_evidence_archive_request_update_guard`
BEFORE UPDATE ON `archive_requests`
WHEN NOT (
  OLD.`evidence_format` = 'dvd-recovery-evidence-v1'
  AND OLD.`status` = 'running' AND NEW.`status` = 'fulfilled'
  AND OLD.`fulfilled_at` IS NULL AND NEW.`fulfilled_at` = NEW.`updated_at`
  AND NEW.`updated_at` >= OLD.`updated_at`
  AND EXISTS (
    SELECT 1 FROM `archive_jobs` AS j
    INNER JOIN `dvd_archive_evidence_manifests` AS m ON m.`original_disc_archive_id` = j.`original_disc_archive_id`
    WHERE j.`archive_request_id` = NEW.`id` AND j.`status` = 'completed'
      AND j.`evidence_format` = NEW.`evidence_format` AND j.`completed_at` = NEW.`fulfilled_at`
      AND m.`revision` = 1
  )
  AND NEW.`id` IS OLD.`id`
  AND NEW.`detected_disc_id` IS OLD.`detected_disc_id`
  AND NEW.`rearchive_source_archive_id` IS OLD.`rearchive_source_archive_id`
  AND NEW.`evidence_format` IS OLD.`evidence_format`
  AND NEW.`priority` IS OLD.`priority`
  AND NEW.`cancellation_requested_at` IS OLD.`cancellation_requested_at`
  AND NEW.`cancelled_at` IS OLD.`cancelled_at`
  AND NEW.`created_at` IS OLD.`created_at`
)
BEGIN
  SELECT CASE
    WHEN OLD.`evidence_format` = 'dvd-recovery-evidence-v1'
      AND NOT (
        NEW.`id` = OLD.`id`
        AND NEW.`detected_disc_id` = OLD.`detected_disc_id`
        AND NEW.`rearchive_source_archive_id` IS OLD.`rearchive_source_archive_id`
        AND NEW.`evidence_format` = OLD.`evidence_format`
        AND NEW.`priority` = OLD.`priority`
        AND NEW.`fulfilled_at` IS OLD.`fulfilled_at`
        AND NEW.`created_at` = OLD.`created_at`
        AND NEW.`updated_at` >= OLD.`updated_at`
        AND (
          (
            OLD.`status` IN ('pending', 'needs_attention')
            AND NEW.`status` = 'cancelled'
            AND OLD.`cancellation_requested_at` IS NULL
            AND OLD.`cancelled_at` IS NULL
            AND NEW.`cancellation_requested_at` IS NOT NULL
            AND NEW.`cancelled_at` IS NOT NULL
            AND NEW.`cancellation_requested_at` = NEW.`updated_at`
            AND NEW.`cancelled_at` = NEW.`updated_at`
          )
          OR (
            OLD.`status` = 'running'
            AND NEW.`status` = 'cancellation_requested'
            AND OLD.`cancellation_requested_at` IS NULL
            AND OLD.`cancelled_at` IS NULL
            AND NEW.`cancellation_requested_at` IS NOT NULL
            AND NEW.`cancelled_at` IS NULL
            AND NEW.`cancellation_requested_at` = NEW.`updated_at`
          )
          OR (
            OLD.`status` = 'cancellation_requested'
            AND NEW.`status` = 'cancelled'
            AND OLD.`cancellation_requested_at` IS NOT NULL
            AND OLD.`cancelled_at` IS NULL
            AND NEW.`cancellation_requested_at`
              = OLD.`cancellation_requested_at`
            AND NEW.`cancelled_at` = NEW.`updated_at`
          )
        )
      )
    THEN RAISE(
      ABORT,
      'New-format DVD Archive Job admission is closed until the recovery and encoding workflow is complete.'
    )
    WHEN EXISTS (
      SELECT 1
      FROM `archive_jobs`
      WHERE `archive_request_id` = OLD.`id`
        AND `evidence_format` IS NOT NEW.`evidence_format`
    )
    THEN RAISE(
      ABORT,
      'Archive Job evidence format must match its Archive Request'
    )
  END;
END;
