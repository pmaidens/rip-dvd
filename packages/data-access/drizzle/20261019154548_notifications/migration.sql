CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`generation` integer NOT NULL,
	`status` text NOT NULL,
	`failure_code` text,
	`claim_token` text,
	`lease_until` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT `fk_notification_deliveries_event_id_notification_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `notification_events`(`id`),
	CONSTRAINT `fk_notification_deliveries_subscription_id_notification_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `notification_subscriptions`(`id`),
	CONSTRAINT "notification_deliveries_id_not_null" CHECK("id" is not null),
	CONSTRAINT "notification_deliveries_status_check" CHECK("status" in ('queued', 'accepted', 'failed')),
	CONSTRAINT "notification_deliveries_generation_check" CHECK("generation" > 0)
);
--> statement-breakpoint
CREATE TABLE `notification_dispatcher` (
	`id` integer PRIMARY KEY,
	`heartbeat_at` integer NOT NULL,
	CONSTRAINT "notification_dispatcher_id_not_null" CHECK("id" is not null and "id" = 1)
);
--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` text PRIMARY KEY,
	`source_event_id` text NOT NULL UNIQUE,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "notification_events_id_not_null" CHECK("id" is not null)
);
--> statement-breakpoint
CREATE TABLE `notification_subscriptions` (
	`id` text PRIMARY KEY,
	`endpoint` text NOT NULL UNIQUE,
	`subscription` text NOT NULL,
	`active` integer NOT NULL,
	`generation` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "notification_subscriptions_id_not_null" CHECK("id" is not null),
	CONSTRAINT "notification_subscriptions_active_check" CHECK("active" in (0, 1)),
	CONSTRAINT "notification_subscriptions_generation_check" CHECK("generation" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_identity` ON `notification_deliveries` (`event_id`,`subscription_id`);--> statement-breakpoint
CREATE INDEX `notification_delivery_queue` ON `notification_deliveries` (`status`,`lease_until`,`created_at`);