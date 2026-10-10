CREATE TABLE "user_reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"repeat" text NOT NULL,
	"fired_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_reminders_repeat_ck" CHECK ("user_reminders"."repeat" in ('none', 'daily', 'mon_sat', 'weekly')),
	CONSTRAINT "user_reminders_text_ck" CHECK (char_length("user_reminders"."text") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "user_reminders" ADD CONSTRAINT "user_reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_reminders_due_idx" ON "user_reminders" USING btree ("due_at") WHERE "user_reminders"."fired_at" is null and "user_reminders"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "user_reminders_user_idx" ON "user_reminders" USING btree ("user_id");