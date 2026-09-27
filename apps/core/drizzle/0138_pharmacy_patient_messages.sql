CREATE TABLE "notify_template_registrations" (
	"template_key" text PRIMARY KEY NOT NULL,
	"dlt_template_id" text,
	"whatsapp_template_name" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_message_preferences" (
	"patient_id" text PRIMARY KEY NOT NULL,
	"channel" text,
	"language" text,
	"refill_reminders" boolean DEFAULT false NOT NULL,
	"reminders_consent_at" timestamp with time zone,
	"reminders_consent_by" text,
	"reminders_consent_via" text,
	"opted_out_at" timestamp with time zone,
	"opted_out_by" text,
	"opted_out_via" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "patient_message_preferences_channel_ck" CHECK ("patient_message_preferences"."channel" is null or "patient_message_preferences"."channel" in ('sms', 'whatsapp')),
	CONSTRAINT "patient_message_preferences_language_ck" CHECK ("patient_message_preferences"."language" is null or "patient_message_preferences"."language" in ('hi', 'en')),
	CONSTRAINT "patient_message_preferences_consent_ck" CHECK (not "patient_message_preferences"."refill_reminders" or ("patient_message_preferences"."reminders_consent_at" is not null and "patient_message_preferences"."reminders_consent_by" is not null and "patient_message_preferences"."reminders_consent_via" is not null)),
	CONSTRAINT "patient_message_preferences_optout_ck" CHECK ("patient_message_preferences"."opted_out_at" is null or ("patient_message_preferences"."opted_out_by" is not null and "patient_message_preferences"."opted_out_via" is not null))
);
--> statement-breakpoint
CREATE TABLE "pharmacy_message_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_phone" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pharmacy_message_settings_one_row_ck" CHECK ("pharmacy_message_settings"."id" = 'main')
);
--> statement-breakpoint
ALTER TABLE "notify_template_registrations" ADD CONSTRAINT "notify_template_registrations_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_message_preferences" ADD CONSTRAINT "patient_message_preferences_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_message_preferences" ADD CONSTRAINT "patient_message_preferences_reminders_consent_by_users_id_fk" FOREIGN KEY ("reminders_consent_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_message_preferences" ADD CONSTRAINT "patient_message_preferences_opted_out_by_users_id_fk" FOREIGN KEY ("opted_out_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_message_preferences" ADD CONSTRAINT "patient_message_preferences_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_message_settings" ADD CONSTRAINT "pharmacy_message_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_message_preferences_reminders_idx" ON "patient_message_preferences" USING btree ("refill_reminders");