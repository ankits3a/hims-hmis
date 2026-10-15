CREATE TABLE "auth_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"model" text,
	"os_version" text,
	"app_version" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ip" text
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "device_row_id" text;--> statement-breakpoint
ALTER TABLE "auth_devices" ADD CONSTRAINT "auth_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_devices_user_device_ux" ON "auth_devices" USING btree ("user_id","device_id");--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_device_row_id_auth_devices_id_fk" FOREIGN KEY ("device_row_id") REFERENCES "public"."auth_devices"("id") ON DELETE no action ON UPDATE no action;