CREATE TABLE `legacy_cutover_staged_sidecars` (
	`originals_library_path` text NOT NULL,
	`sidecar_path` text NOT NULL,
	`archive_path` text NOT NULL,
	`fingerprint` text NOT NULL,
	CONSTRAINT `legacy_cutover_staged_sidecars_pk` PRIMARY KEY(`originals_library_path`, `sidecar_path`)
);
--> statement-breakpoint
CREATE INDEX `legacy_cutover_staged_sidecars_library_idx` ON `legacy_cutover_staged_sidecars` (`originals_library_path`);