CREATE TABLE "phone_push_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_row_id" text NOT NULL,
	"alert_id" text,
	"category" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_push_sends_outcome_ck" CHECK ("phone_push_sends"."outcome" in ('sent', 'gone'))
);
--> statement-breakpoint
ALTER TABLE "auth_devices" ADD COLUMN "push_token" text;--> statement-breakpoint
ALTER TABLE "auth_devices" ADD COLUMN "push_token_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_devices" ADD COLUMN "push_language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_devices" ADD COLUMN "push_muted" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_push_sends" ADD CONSTRAINT "phone_push_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_push_sends" ADD CONSTRAINT "phone_push_sends_device_row_id_auth_devices_id_fk" FOREIGN KEY ("device_row_id") REFERENCES "public"."auth_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_push_sends_alert_device_ux" ON "phone_push_sends" USING btree ("alert_id","device_row_id");--> statement-breakpoint
CREATE INDEX "phone_push_sends_user_at_idx" ON "phone_push_sends" USING btree ("user_id","created_at");