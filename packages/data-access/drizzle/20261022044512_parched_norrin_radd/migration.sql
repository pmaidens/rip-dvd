CREATE TABLE `dvd_structural_assessments` (
	`id` text PRIMARY KEY,
	`original_disc_archive_id` text NOT NULL,
	`manifest_id` text NOT NULL,
	`manifest_revision` integer NOT NULL,
	`manifest_digest` text NOT NULL,
	`accepted_end_lba_exclusive` integer NOT NULL,
	`policy_version` text NOT NULL,
	`validity` text NOT NULL,
	`findings` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_structural_assessments_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_structural_assessments_manifest_id_dvd_archive_evidence_manifests_id_fk` FOREIGN KEY (`manifest_id`) REFERENCES `dvd_archive_evidence_manifests`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_structural_assessments_identity_check" CHECK(length("id") = 90 and substr("id", 1, 26) = 'dvd-structural-assessment:' and substr("id", 27) not glob '*[^0-9a-f]*'),
	CONSTRAINT "dvd_structural_assessments_checkpoint_check" CHECK(typeof("manifest_revision") = 'integer' and "manifest_revision" > 0 and length("manifest_digest") = 64 and "manifest_digest" not glob '*[^0-9a-f]*' and typeof("accepted_end_lba_exclusive") = 'integer' and "accepted_end_lba_exclusive" > 0),
	CONSTRAINT "dvd_structural_assessments_policy_check" CHECK("policy_version" = 'dvd-structural-assessment-v1'),
	CONSTRAINT "dvd_structural_assessments_validity_check" CHECK("validity" in ('valid', 'invalid', 'unknown')),
	CONSTRAINT "dvd_structural_assessments_findings_check" CHECK(json_valid("findings") and json_type("findings") = 'array' and json_array_length("findings") = 3)
);
--> statement-breakpoint
CREATE TABLE `dvd_structural_check_attempts` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`original_disc_archive_id` text NOT NULL,
	`manifest_id` text NOT NULL,
	`manifest_revision` integer NOT NULL,
	`manifest_digest` text NOT NULL,
	`accepted_end_lba_exclusive` integer NOT NULL,
	`outcome` text NOT NULL,
	`assessment_id` text,
	`findings` text,
	`failure_code` text,
	`failure_message` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_dvd_structural_check_attempts_original_disc_archive_id_original_disc_archives_id_fk` FOREIGN KEY (`original_disc_archive_id`) REFERENCES `original_disc_archives`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_structural_check_attempts_manifest_id_dvd_archive_evidence_manifests_id_fk` FOREIGN KEY (`manifest_id`) REFERENCES `dvd_archive_evidence_manifests`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_dvd_structural_check_attempts_assessment_id_dvd_structural_assessments_id_fk` FOREIGN KEY (`assessment_id`) REFERENCES `dvd_structural_assessments`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "dvd_structural_check_attempts_checkpoint_check" CHECK(typeof("manifest_revision") = 'integer' and "manifest_revision" > 0 and length("manifest_digest") = 64 and "manifest_digest" not glob '*[^0-9a-f]*' and typeof("accepted_end_lba_exclusive") = 'integer' and "accepted_end_lba_exclusive" > 0),
	CONSTRAINT "dvd_structural_check_attempts_outcome_check" CHECK("outcome" in ('completed', 'failed')),
	CONSTRAINT "dvd_structural_check_attempts_shape_check" CHECK(("outcome" = 'completed' and "assessment_id" is not null and "findings" is not null and json_valid("findings") and json_type("findings") = 'array' and json_array_length("findings") = 3 and "failure_code" is null and "failure_message" is null) or ("outcome" = 'failed' and "assessment_id" is null and "findings" is null and typeof("failure_code") = 'text' and length("failure_code") between 1 and 128 and typeof("failure_message") = 'text' and length("failure_message") between 1 and 512))
);
--> statement-breakpoint
CREATE INDEX `dvd_structural_assessments_checkpoint_idx` ON `dvd_structural_assessments` (`original_disc_archive_id`,`manifest_revision`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `dvd_structural_check_attempts_checkpoint_idx` ON `dvd_structural_check_attempts` (`original_disc_archive_id`,`manifest_revision`,`sequence`);--> statement-breakpoint
CREATE TRIGGER `dvd_structural_assessment_insert_guard`
BEFORE INSERT ON `dvd_structural_assessments`
WHEN NOT EXISTS (
  SELECT 1 FROM `dvd_archive_evidence_headers` AS header
  WHERE header.`original_disc_archive_id` = NEW.`original_disc_archive_id`
    AND header.`evidence_format` = 'dvd-recovery-evidence-v1'
    AND header.`current_manifest_id` = NEW.`manifest_id`
    AND header.`current_manifest_revision` = NEW.`manifest_revision`
    AND header.`current_manifest_digest` = NEW.`manifest_digest`
    AND header.`accepted_end_lba_exclusive` = NEW.`accepted_end_lba_exclusive`
) OR NOT EXISTS (
  SELECT 1 FROM `dvd_archive_evidence_manifests` AS manifest
  WHERE manifest.`id` = NEW.`manifest_id`
    AND manifest.`original_disc_archive_id` = NEW.`original_disc_archive_id`
    AND manifest.`revision` = NEW.`manifest_revision`
    AND manifest.`manifest_digest` = NEW.`manifest_digest`
    AND manifest.`accepted_end_lba_exclusive` = NEW.`accepted_end_lba_exclusive`
    AND manifest.`evidence_format` = 'dvd-recovery-evidence-v1'
)
BEGIN
  SELECT RAISE(ABORT, 'DVD structural assessment must match a committed checkpoint');
END;--> statement-breakpoint
CREATE TRIGGER `dvd_structural_assessment_update_guard`
BEFORE UPDATE ON `dvd_structural_assessments`
BEGIN
  SELECT RAISE(ABORT, 'DVD structural assessments are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `dvd_structural_assessment_delete_guard`
BEFORE DELETE ON `dvd_structural_assessments`
BEGIN
  SELECT RAISE(ABORT, 'DVD structural assessments are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `dvd_structural_check_attempt_insert_guard`
BEFORE INSERT ON `dvd_structural_check_attempts`
WHEN NOT EXISTS (
  SELECT 1 FROM `dvd_archive_evidence_headers` AS header
  WHERE header.`original_disc_archive_id` = NEW.`original_disc_archive_id`
    AND header.`evidence_format` = 'dvd-recovery-evidence-v1'
    AND header.`current_manifest_id` = NEW.`manifest_id`
    AND header.`current_manifest_revision` = NEW.`manifest_revision`
    AND header.`current_manifest_digest` = NEW.`manifest_digest`
    AND header.`accepted_end_lba_exclusive` = NEW.`accepted_end_lba_exclusive`
) OR NOT EXISTS (
  SELECT 1 FROM `dvd_archive_evidence_manifests` AS manifest
  WHERE manifest.`id` = NEW.`manifest_id`
    AND manifest.`original_disc_archive_id` = NEW.`original_disc_archive_id`
    AND manifest.`revision` = NEW.`manifest_revision`
    AND manifest.`manifest_digest` = NEW.`manifest_digest`
    AND manifest.`accepted_end_lba_exclusive` = NEW.`accepted_end_lba_exclusive`
    AND manifest.`evidence_format` = 'dvd-recovery-evidence-v1'
) OR (
  NEW.`outcome` = 'completed' AND NOT EXISTS (
    SELECT 1 FROM `dvd_structural_assessments` AS assessment
    WHERE assessment.`id` = NEW.`assessment_id`
      AND assessment.`original_disc_archive_id` = NEW.`original_disc_archive_id`
      AND assessment.`manifest_id` = NEW.`manifest_id`
      AND assessment.`manifest_revision` = NEW.`manifest_revision`
      AND assessment.`manifest_digest` = NEW.`manifest_digest`
      AND assessment.`accepted_end_lba_exclusive` = NEW.`accepted_end_lba_exclusive`
      AND assessment.`findings` = NEW.`findings`
  )
)
BEGIN
  SELECT RAISE(ABORT, 'DVD structural check attempt must match its checkpoint and assessment');
END;--> statement-breakpoint
CREATE TRIGGER `dvd_structural_check_attempt_update_guard`
BEFORE UPDATE ON `dvd_structural_check_attempts`
BEGIN
  SELECT RAISE(ABORT, 'DVD structural check attempts are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `dvd_structural_check_attempt_delete_guard`
BEFORE DELETE ON `dvd_structural_check_attempts`
BEGIN
  SELECT RAISE(ABORT, 'DVD structural check attempts are immutable');
END;
