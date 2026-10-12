CREATE TABLE "copilot_user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"phone_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
