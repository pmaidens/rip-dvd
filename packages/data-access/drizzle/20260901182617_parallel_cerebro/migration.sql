PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_worker_incidents` (
	`id` text PRIMARY KEY,
	`schema_version` integer NOT NULL,
	`worker_kind` text NOT NULL,
	`reason_code` text NOT NULL,
	`phase` text NOT NULL,
	`retryability` text NOT NULL,
	`evidence` text NOT NULL,
	`first_observed_at` integer NOT NULL,
	`last_observed_at` integer NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`resolved_at` integer,
	CONSTRAINT "worker_incidents_id_not_null" CHECK("id" is not null),
	CONSTRAINT "worker_incidents_schema_version_check" CHECK("schema_version" = 1),
	CONSTRAINT "worker_incidents_worker_kind_check" CHECK("worker_kind" in ('archive', 'encode')),
	CONSTRAINT "worker_incidents_reason_code_check" CHECK("reason_code" in ('poll_failure', 'claim_recovery_failure', 'publication_recovery_failure')),
	CONSTRAINT "worker_incidents_phase_check" CHECK("phase" in ('polling', 'claim_recovery', 'publication_recovery')),
	CONSTRAINT "worker_incidents_retryability_check" CHECK("retryability" in ('automatic')),
	CONSTRAINT "worker_incidents_occurrence_count_check" CHECK(typeof("occurrence_count") = 'integer' and "occurrence_count" > 0),
	CONSTRAINT "worker_incidents_observation_order_check" CHECK("last_observed_at" >= "first_observed_at"),
	CONSTRAINT "worker_incidents_resolution_order_check" CHECK("resolved_at" is null or "resolved_at" >= "last_observed_at")
);
--> statement-breakpoint
INSERT INTO `__new_worker_incidents`(`id`, `schema_version`, `worker_kind`, `reason_code`, `phase`, `retryability`, `evidence`, `first_observed_at`, `last_observed_at`, `occurrence_count`, `resolved_at`) SELECT `id`, `schema_version`, `worker_kind`, `reason_code`, `phase`, `retryability`, `evidence`, `first_observed_at`, `last_observed_at`, `occurrence_count`, `resolved_at` FROM `worker_incidents`;--> statement-breakpoint
DROP TABLE `worker_incidents`;--> statement-breakpoint
ALTER TABLE `__new_worker_incidents` RENAME TO `worker_incidents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `worker_incidents_active_identity_unique` ON `worker_incidents` (`worker_kind`,`reason_code`,`phase`,`evidence`) WHERE "worker_incidents"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX `worker_incidents_worker_activity_idx` ON `worker_incidents` (`worker_kind`,`resolved_at`,`last_observed_at`);