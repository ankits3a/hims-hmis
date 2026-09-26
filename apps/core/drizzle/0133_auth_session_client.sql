ALTER TABLE "auth_sessions" ADD COLUMN "client_ip" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "user_agent" text;