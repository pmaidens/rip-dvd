CREATE TABLE `dvd_recovery_storage_preflights` (
	`scope` text PRIMARY KEY,
	`contract_version` text NOT NULL,
	`status` text NOT NULL,
	`reason_code` text,
	`facts` text NOT NULL,
	`checked_at` integer NOT NULL,
	CONSTRAINT "dvd_recovery_storage_preflights_scope_check" CHECK("scope" is not null and "scope" = 'originals_library'),
	CONSTRAINT "dvd_recovery_storage_preflights_version_check" CHECK("contract_version" = 'dvd-recovery-storage-preflight-v1'),
	CONSTRAINT "dvd_recovery_storage_preflights_status_check" CHECK("status" in ('supported', 'unsupported', 'failed_prerequisite')),
	CONSTRAINT "dvd_recovery_storage_preflights_reason_check" CHECK(("status" = 'supported' and "reason_code" is null) or ("status" = 'unsupported' and "reason_code" is not null and "reason_code" = 'STORAGE_UNSUPPORTED') or ("status" = 'failed_prerequisite' and "reason_code" is not null and "reason_code" in ('STORAGE_INSPECTION_FAILED', 'JOURNAL_CAPACITY_INSUFFICIENT', 'JOURNAL_RESERVATION_FAILED', 'JOURNAL_SYNC_FAILED', 'IMAGE_SYNC_FAILED', 'CHECKPOINT_SYNC_FAILED', 'CHECKPOINT_REPLACEMENT_FAILED', 'DIRECTORY_SYNC_FAILED', 'WRITER_EXCLUSION_FAILED', 'PREFLIGHT_CLEANUP_FAILED'))),
	CONSTRAINT "dvd_recovery_storage_preflights_facts_check" CHECK(json_valid("facts") and json_type("facts") = 'object')
);
