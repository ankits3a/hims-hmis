CREATE TABLE "er_bands" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"serial" text NOT NULL,
	"size" text NOT NULL,
	"site" text NOT NULL,
	"printer_id" text,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"printed_by" text NOT NULL,
	"printed_at" timestamp with time zone NOT NULL,
	"void_reason" text,
	"voided_by" text,
	"voided_at" timestamp with time zone,
	CONSTRAINT "er_bands_status_ck" CHECK ("er_bands"."status" in ('printed', 'void'))
);
--> statement-breakpoint
CREATE TABLE "er_episodes" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_no" text NOT NULL,
	"episode_year" integer NOT NULL,
	"episode_serial" integer NOT NULL,
	"patient_id" text NOT NULL,
	"workflow_instance_id" text NOT NULL,
	"state" text NOT NULL,
	"arrival_mode" text NOT NULL,
	"arrived_at" timestamp with time zone NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"registered_by" text NOT NULL,
	"pre_alert_id" text,
	"unidentified" boolean DEFAULT false NOT NULL,
	"alias" text,
	"alias_year" integer,
	"alias_serial" integer,
	"age_band" text,
	"marks" text,
	"complaint" text,
	"brought_by" jsonb,
	"returned_within_24h" boolean DEFAULT false NOT NULL,
	"previous_episode_id" text,
	"paper_serial" text,
	"brought_dead_examined_by" text,
	"brought_dead_examined_at" timestamp with time zone,
	"ecg_strip_recorded" boolean,
	"identity_merge_request_id" text,
	"identity_true_patient_id" text,
	"outcome" text,
	"departed_at" timestamp with time zone,
	"provenance" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "er_episodes_state_ck" CHECK ("er_episodes"."state" in ('arrived', 'triaged', 'in_treatment', 'disposition_decided', 'departed', 'brought_dead')),
	CONSTRAINT "er_episodes_mode_ck" CHECK ("er_episodes"."arrival_mode" in ('walk_in', 'private_vehicle', 'own_ambulance', 'ambulance_108', 'police', 'referred_in', 'inter_facility')),
	CONSTRAINT "er_episodes_band_ck" CHECK ("er_episodes"."age_band" is null or "er_episodes"."age_band" in ('infant', 'child', 'teen', 'young_adult', 'adult', 'elderly')),
	CONSTRAINT "er_episodes_alias_ck" CHECK ("er_episodes"."unidentified" = ("er_episodes"."alias" is not null)),
	CONSTRAINT "er_episodes_dead_ck" CHECK (("er_episodes"."state" = 'brought_dead') = ("er_episodes"."brought_dead_examined_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "er_pre_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"mode" text NOT NULL,
	"expected_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	"arrived_count" integer DEFAULT 0 NOT NULL,
	"sex" text,
	"age_band" text,
	"complaint" text,
	"caller" text,
	"caller_phone" text,
	"vehicle_no" text,
	"cancel_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "er_pre_alerts_state_ck" CHECK ("er_pre_alerts"."state" in ('expected', 'arrived', 'cancelled')),
	CONSTRAINT "er_pre_alerts_count_ck" CHECK ("er_pre_alerts"."count" >= 1 and "er_pre_alerts"."arrived_count" >= 0 and "er_pre_alerts"."arrived_count" <= "er_pre_alerts"."count")
);
--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "identity_status" text DEFAULT 'identified' NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_identity_status_ck" CHECK ("patients"."identity_status" in ('identified', 'unidentified'));--> statement-breakpoint
ALTER TABLE "er_bands" ADD CONSTRAINT "er_bands_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD CONSTRAINT "er_episodes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "er_bands_serial_ux" ON "er_bands" USING btree ("serial");--> statement-breakpoint
CREATE UNIQUE INDEX "er_bands_live_episode_ux" ON "er_bands" USING btree ("episode_id") WHERE "er_bands"."status" = 'printed';--> statement-breakpoint
CREATE UNIQUE INDEX "er_episodes_no_ux" ON "er_episodes" USING btree ("episode_no");--> statement-breakpoint
CREATE UNIQUE INDEX "er_episodes_year_serial_ux" ON "er_episodes" USING btree ("episode_year","episode_serial");--> statement-breakpoint
CREATE UNIQUE INDEX "er_episodes_open_patient_ux" ON "er_episodes" USING btree ("patient_id") WHERE "er_episodes"."state" in ('arrived', 'triaged', 'in_treatment', 'disposition_decided');--> statement-breakpoint
CREATE UNIQUE INDEX "er_episodes_alias_ux" ON "er_episodes" USING btree ("alias_year","alias_serial") WHERE "er_episodes"."alias_serial" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "er_episodes_paper_serial_ux" ON "er_episodes" USING btree ("paper_serial") WHERE "er_episodes"."paper_serial" is not null;--> statement-breakpoint
CREATE INDEX "er_episodes_state_idx" ON "er_episodes" USING btree ("state","arrived_at");--> statement-breakpoint
CREATE INDEX "er_episodes_patient_idx" ON "er_episodes" USING btree ("patient_id","arrived_at");--> statement-breakpoint
CREATE INDEX "er_pre_alerts_expected_idx" ON "er_pre_alerts" USING btree ("expires_at") WHERE "er_pre_alerts"."state" = 'expected';