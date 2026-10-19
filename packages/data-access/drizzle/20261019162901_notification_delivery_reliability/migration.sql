CREATE TABLE `notification_event_receipts` (
	`source_event_id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`payload_digest` text NOT NULL,
	`recipient_count` integer NOT NULL,
	CONSTRAINT "notification_event_receipts_id_not_null" CHECK("source_event_id" is not null)
);
--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD `next_attempt_at` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_deliveries` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`generation` integer NOT NULL,
	`status` text NOT NULL,
	`failure_code` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`claim_token` text,
	`lease_until` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT `fk_notification_deliveries_event_id_notification_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `notification_events`(`id`),
	CONSTRAINT `fk_notification_deliveries_subscription_id_notification_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `notification_subscriptions`(`id`),
	CONSTRAINT "notification_deliveries_id_not_null" CHECK("id" is not null),
	CONSTRAINT "notification_deliveries_status_check" CHECK("status" in ('queued', 'retrying', 'accepted', 'expired', 'failed')),
	CONSTRAINT "notification_deliveries_attempt_count_check" CHECK("attempt_count" >= 0 and "attempt_count" <= 8),
	CONSTRAINT "notification_deliveries_generation_check" CHECK("generation" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_notification_deliveries`(`id`, `event_id`, `subscription_id`, `generation`, `status`, `failure_code`, `claim_token`, `lease_until`, `created_at`, `completed_at`) SELECT `id`, `event_id`, `subscription_id`, `generation`, `status`, `failure_code`, `claim_token`, `lease_until`, `created_at`, `completed_at` FROM `notification_deliveries`;--> statement-breakpoint
DROP TABLE `notification_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_notification_deliveries` RENAME TO `notification_deliveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_identity` ON `notification_deliveries` (`event_id`,`subscription_id`);--> statement-breakpoint
CREATE INDEX `notification_delivery_queue` ON `notification_deliveries` (`status`,`next_attempt_at`,`lease_until`,`created_at`);
