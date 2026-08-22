CREATE TABLE "config_validation_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"ok" boolean NOT NULL,
	"scopes" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "downtime_form_counters" (
	"form_kind" text PRIMARY KEY NOT NULL,
	"next_serial" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "downtime_kit_ranges" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"kit_id" text NOT NULL,
	"desk" text NOT NULL,
	"form_kind" text NOT NULL,
	"start_serial" bigint NOT NULL,
	"end_serial" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "downtime_kits" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"note" text,
	"generated_by" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interfaces" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"location" text,
	"stale_after_ms" integer DEFAULT 180000 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"status" text DEFAULT 'unknown' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operating_mode_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"from_mode" text NOT NULL,
	"to_mode" text NOT NULL,
	"note" text,
	"report_id" text,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "downtime_kit_ranges" ADD CONSTRAINT "downtime_kit_ranges_kit_id_downtime_kits_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."downtime_kits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "config_validation_reports_seq_idx" ON "config_validation_reports" USING btree ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "downtime_kit_ranges_kit_desk_kind_ux" ON "downtime_kit_ranges" USING btree ("kit_id","desk","form_kind");--> statement-breakpoint
CREATE INDEX "downtime_kit_ranges_kit_idx" ON "downtime_kit_ranges" USING btree ("kit_id");--> statement-breakpoint
CREATE INDEX "downtime_kits_seq_idx" ON "downtime_kits" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "interfaces_status_active_idx" ON "interfaces" USING btree ("status","active");--> statement-breakpoint
CREATE INDEX "operating_mode_changes_seq_idx" ON "operating_mode_changes" USING btree ("seq");