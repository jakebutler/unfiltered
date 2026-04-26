CREATE TABLE `billing_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`ts` integer NOT NULL,
	`stripe_meter_event_id` text
);
--> statement-breakpoint
CREATE INDEX `billing_events_workspace_idx` ON `billing_events` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `billing_events_ts_idx` ON `billing_events` (`ts`);--> statement-breakpoint
CREATE TABLE `bot_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`ts` real NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bot_events_session_idx` ON `bot_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `bot_events_type_idx` ON `bot_events` (`type`);--> statement-breakpoint
CREATE TABLE `camera_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`t` real NOT NULL,
	`emotion` text,
	`focus` text,
	`engagement` text,
	`notes` text
);
--> statement-breakpoint
CREATE INDEX `camera_signals_session_idx` ON `camera_signals` (`session_id`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`study_id` text NOT NULL,
	`session_id` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`severity` text NOT NULL,
	`recommendation` text,
	`evidence_json` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`share_slug` text,
	`share_settings` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `findings_study_idx` ON `findings` (`study_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `findings_share_slug_idx` ON `findings` (`share_slug`);--> statement-breakpoint
CREATE TABLE `friction_moments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`t_start` real NOT NULL,
	`t_end` real NOT NULL,
	`severity` text NOT NULL,
	`description` text NOT NULL,
	`evidence_json` text NOT NULL,
	`theme_ids` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `friction_moments_session_idx` ON `friction_moments` (`session_id`);--> statement-breakpoint
CREATE TABLE `guides` (
	`id` text PRIMARY KEY NOT NULL,
	`study_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`json` text NOT NULL,
	`human_readable` text,
	`finalized_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `guides_study_idx` ON `guides` (`study_id`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`study_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`signed_token` text NOT NULL,
	`sent_at` integer,
	`opened_at` integer,
	`completed_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `invitations_study_idx` ON `invitations` (`study_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_idx` ON `invitations` (`signed_token`);--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`study_id` text,
	`name` text NOT NULL,
	`demographics` text,
	`goals` text,
	`expertise` text,
	`attitudes` text,
	`anti_patterns` text,
	`source` text DEFAULT 'ai' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `personas_workspace_idx` ON `personas` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `personas_study_idx` ON `personas` (`study_id`);--> statement-breakpoint
CREATE TABLE `quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`t_start` real NOT NULL,
	`t_end` real NOT NULL,
	`text` text NOT NULL,
	`significance` text NOT NULL,
	`theme_ids` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quotes_session_idx` ON `quotes` (`session_id`);--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`r2_key` text NOT NULL,
	`duration_sec` real,
	`size_bytes` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recordings_session_idx` ON `recordings` (`session_id`);--> statement-breakpoint
CREATE TABLE `screen_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`t` real NOT NULL,
	`page` text,
	`action` text,
	`inferred_events` text,
	`friction_flags` text
);
--> statement-breakpoint
CREATE INDEX `screen_signals_session_idx` ON `screen_signals` (`session_id`);--> statement-breakpoint
CREATE TABLE `session_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow_instance_id` text,
	`completed_at` integer,
	`error_msg` text,
	`summary` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_analyses_session_id_unique` ON `session_analyses` (`session_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`study_id` text NOT NULL,
	`invitation_id` text,
	`persona_id` text,
	`is_synthetic` integer DEFAULT false NOT NULL,
	`runtime_mode` text DEFAULT 'voice' NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`durable_object_id` text,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_study_idx` ON `sessions` (`study_id`);--> statement-breakpoint
CREATE INDEX `sessions_invitation_idx` ON `sessions` (`invitation_id`);--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);--> statement-breakpoint
CREATE TABLE `studies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`study_type` text DEFAULT 'usability' NOT NULL,
	`target_url` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `studies_workspace_idx` ON `studies` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `themes` (
	`id` text PRIMARY KEY NOT NULL,
	`study_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`evidence_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `themes_study_idx` ON `themes` (`study_id`);--> statement-breakpoint
CREATE TABLE `transcript_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`speaker` text NOT NULL,
	`text` text NOT NULL,
	`t_start` real NOT NULL,
	`t_end` real NOT NULL,
	`sequence` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `transcript_chunks_session_idx` ON `transcript_chunks` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_chunks_session_seq_idx` ON `transcript_chunks` (`session_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`workos_user_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`avatar_url` text,
	`default_workspace_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_workos_user_id_idx` ON `users` (`workos_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_workspace_user_idx` ON `workspace_members` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`billing_plan` text DEFAULT 'free' NOT NULL,
	`retention_days` integer DEFAULT 365 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
