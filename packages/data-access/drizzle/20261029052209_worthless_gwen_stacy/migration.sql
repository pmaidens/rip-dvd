CREATE TABLE `browser_renditions` (
	`id` text PRIMARY KEY,
	`source_identity` text NOT NULL,
	`status` text NOT NULL,
	`record` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "browser_renditions_id_not_null" CHECK("id" is not null),
	CONSTRAINT "browser_renditions_status_check" CHECK("status" in ('queued', 'generating', 'complete', 'failed', 'interrupted')),
	CONSTRAINT "browser_renditions_record_check" CHECK(json_valid("record") and json_extract("record", '$.id') is "id" and json_extract("record", '$.status') is "status" and json_extract("record", '$.sourceIdentity') is "source_identity")
);
--> statement-breakpoint
CREATE INDEX `browser_renditions_queue_idx` ON `browser_renditions` (`status`,`created_at`,`id`);