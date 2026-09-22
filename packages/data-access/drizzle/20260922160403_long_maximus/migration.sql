CREATE TABLE `mutation_invocations` (
	`key` text PRIMARY KEY,
	`operation` text NOT NULL,
	`semantic_input` text NOT NULL,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "mutation_invocations_key_not_null" CHECK("key" is not null)
);
