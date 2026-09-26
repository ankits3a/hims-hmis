ALTER TABLE "user_totp" ADD COLUMN "last_used_step" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "badge_issued_at" timestamp with time zone DEFAULT now() NOT NULL;