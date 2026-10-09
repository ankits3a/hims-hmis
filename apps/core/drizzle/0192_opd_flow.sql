CREATE TABLE "opd_flow_baselines" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"leg" text NOT NULL,
	"weekday" integer NOT NULL,
	"hour" integer NOT NULL,
	"n" integer NOT NULL,
	"median_min" double precision,
	"p90_min" double precision,
	"window_from" date NOT NULL,
	"window_to" date NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "opd_flow_baselines_leg_ck" CHECK ("opd_flow_baselines"."leg" in ('desk_vitals', 'vitals_doctor', 'desk_doctor')),
	CONSTRAINT "opd_flow_baselines_weekday_ck" CHECK ("opd_flow_baselines"."weekday" between -1 and 6),
	CONSTRAINT "opd_flow_baselines_hour_ck" CHECK ("opd_flow_baselines"."hour" = -1 or "opd_flow_baselines"."hour" between 0 and 23)
);
--> statement-breakpoint
CREATE TABLE "opd_flow_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_key" text NOT NULL,
	"type" text NOT NULL,
	"scope" text NOT NULL,
	"leg" text NOT NULL,
	"weekday" integer,
	"hour_from" integer,
	"hour_to" integer,
	"observed_min" double precision NOT NULL,
	"baseline_min" double precision NOT NULL,
	"patients" integer NOT NULL,
	"minutes_lost" integer NOT NULL,
	"first_seen" date NOT NULL,
	"last_seen" date NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"dismissed_by" text,
	"dismissed_at" timestamp with time zone,
	"dismissed_observed_min" double precision,
	"tried_by" text,
	"tried_at" timestamp with time zone,
	"before_median_min" double precision,
	"after_median_min" double precision,
	"resolved_on" date,
	"minutes_won" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opd_flow_findings_type_ck" CHECK ("opd_flow_findings"."type" in ('bay_peak', 'doctor_start_late', 'dept_outlier', 'week_regression')),
	CONSTRAINT "opd_flow_findings_state_ck" CHECK ("opd_flow_findings"."state" in ('open', 'dismissed', 'resolved')),
	CONSTRAINT "opd_flow_findings_leg_ck" CHECK ("opd_flow_findings"."leg" in ('desk_vitals', 'vitals_doctor', 'desk_doctor')),
	CONSTRAINT "opd_flow_findings_dismissed_ck" CHECK (("opd_flow_findings"."state" = 'dismissed') = ("opd_flow_findings"."dismissed_at" is not null) and ("opd_flow_findings"."dismissed_by" is null) = ("opd_flow_findings"."dismissed_at" is null)),
	CONSTRAINT "opd_flow_findings_tried_ck" CHECK (("opd_flow_findings"."tried_by" is null) = ("opd_flow_findings"."tried_at" is null)),
	CONSTRAINT "opd_flow_findings_note_ck" CHECK ("opd_flow_findings"."note" is null or "opd_flow_findings"."note" in ('returned', 'returned_worse'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "opd_flow_baselines_cell_uq" ON "opd_flow_baselines" USING btree ("scope","leg","weekday","hour");--> statement-breakpoint
CREATE UNIQUE INDEX "opd_flow_findings_live_uq" ON "opd_flow_findings" USING btree ("finding_key") WHERE "opd_flow_findings"."state" <> 'resolved';--> statement-breakpoint
CREATE INDEX "opd_flow_findings_state_idx" ON "opd_flow_findings" USING btree ("state");