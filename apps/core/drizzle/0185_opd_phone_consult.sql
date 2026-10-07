CREATE TABLE "opd_rx_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"department_id" text,
	"name" text NOT NULL,
	"body" jsonb NOT NULL,
	"signed_by" text,
	"signed_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "opd_rx_sets_scope_ck" CHECK ("opd_rx_sets"."scope" in ('doctor', 'department')),
	CONSTRAINT "opd_rx_sets_owner_ck" CHECK (("opd_rx_sets"."scope" = 'doctor' and "opd_rx_sets"."owner_user_id" is not null and "opd_rx_sets"."department_id" is null) or ("opd_rx_sets"."scope" = 'department' and "opd_rx_sets"."department_id" is not null and "opd_rx_sets"."owner_user_id" is null)),
	CONSTRAINT "opd_rx_sets_signed_ck" CHECK (("opd_rx_sets"."signed_by" is null) = ("opd_rx_sets"."signed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "opd_voice_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"model" text DEFAULT 'gpt-4o-transcribe' NOT NULL,
	"daily_minutes_cap" integer DEFAULT 120 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "opd_voice_settings_model_ck" CHECK ("opd_voice_settings"."model" in ('gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1')),
	CONSTRAINT "opd_voice_settings_cap_ck" CHECK ("opd_voice_settings"."daily_minutes_cap" >= 0 and "opd_voice_settings"."daily_minutes_cap" <= 6000)
);
--> statement-breakpoint
CREATE TABLE "opd_voice_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"model" text NOT NULL,
	"seconds" integer NOT NULL,
	"transcript_chars" integer NOT NULL,
	"changed_chars" integer,
	"kept_chars" integer,
	"ok" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "opd_voice_usage_seconds_ck" CHECK ("opd_voice_usage"."seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "opd_rx_sets" ADD CONSTRAINT "opd_rx_sets_department_id_opd_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."opd_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opd_rx_sets_owner_idx" ON "opd_rx_sets" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "opd_rx_sets_department_idx" ON "opd_rx_sets" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "opd_voice_usage_user_day_idx" ON "opd_voice_usage" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "opd_voice_usage_day_idx" ON "opd_voice_usage" USING btree ("day");