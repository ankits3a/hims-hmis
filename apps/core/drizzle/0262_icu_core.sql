-- ICU IC-1 (#984, decision 0090): the ICU core. Additive. HAND EDIT (the only one): `icu_numerics` is PARTITIONED BY RANGE
-- (observed_at); modules/icu/partitions.ts creates one partition per UTC day on demand and drops those older than 72 h.
-- Numbered 0262 on lane/ipd-train; renumbered at merge.
CREATE TABLE "icu_alarm_events" (
	"id" text PRIMARY KEY NOT NULL,
	"alarm_id" text,
	"admission_id" text NOT NULL,
	"act" text NOT NULL,
	"rung" text,
	"actor_id" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "icu_alarm_events_act_ck" CHECK ("icu_alarm_events"."act" in ('raised', 'escalated', 'acknowledged', 'storm_flagged'))
);
--> statement-breakpoint
CREATE TABLE "icu_alarm_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"param" text NOT NULL,
	"low" double precision,
	"high" double precision,
	"reason" text,
	"ordered_by" text NOT NULL,
	"ordered_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	"monitor_set_by" text,
	"monitor_set_at" timestamp with time zone,
	CONSTRAINT "icu_alarm_limits_ttl_ck" CHECK ("icu_alarm_limits"."expires_at" = "icu_alarm_limits"."ordered_at" + interval '24 hours'),
	CONSTRAINT "icu_alarm_limits_some_ck" CHECK ("icu_alarm_limits"."low" is not null or "icu_alarm_limits"."high" is not null)
);
--> statement-breakpoint
CREATE TABLE "icu_alarms" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"bed_id" text NOT NULL,
	"source" text NOT NULL,
	"severity" text NOT NULL,
	"param" text,
	"message" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"rung" text NOT NULL,
	"rung_since" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"ack_by" text,
	"ack_at" timestamp with time zone,
	"ack_note" text,
	"limit_id" text,
	CONSTRAINT "icu_alarms_source_ck" CHECK ("icu_alarms"."source" in ('device', 'advisory')),
	CONSTRAINT "icu_alarms_severity_ck" CHECK ("icu_alarms"."severity" in ('life_threatening', 'high', 'medium', 'low', 'advisory')),
	CONSTRAINT "icu_alarms_rung_ck" CHECK ("icu_alarms"."rung" in ('bed_nurse', 'station', 'duty_doctor', 'intensivist')),
	CONSTRAINT "icu_alarms_state_ck" CHECK ("icu_alarms"."state" in ('open', 'acknowledged')),
	CONSTRAINT "icu_alarms_ack_ck" CHECK (("icu_alarms"."state" = 'acknowledged') = ("icu_alarms"."ack_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "icu_bundles" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"kind" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"done_at" timestamp with time zone,
	"done_by" text,
	"checks" jsonb,
	"note" text,
	CONSTRAINT "icu_bundles_kind_ck" CHECK ("icu_bundles"."kind" in ('ventilator', 'central_line', 'catheter', 'sepsis_hour1', 'dvt', 'pressure'))
);
--> statement-breakpoint
CREATE TABLE "icu_chart_hours" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"signed_by" text,
	"signed_at" timestamp with time zone,
	"vitals_id" text,
	CONSTRAINT "icu_chart_hours_state_ck" CHECK ("icu_chart_hours"."state" in ('draft', 'signed')),
	CONSTRAINT "icu_chart_hours_mode_ck" CHECK ("icu_chart_hours"."mode" in ('device', 'manual')),
	CONSTRAINT "icu_chart_hours_signed_ck" CHECK (("icu_chart_hours"."state" = 'signed') = ("icu_chart_hours"."signed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "icu_chart_values" (
	"id" text PRIMARY KEY NOT NULL,
	"hour_id" text NOT NULL,
	"param" text NOT NULL,
	"value" double precision,
	"source" text NOT NULL,
	"technical" text,
	"happened_at" timestamp with time zone NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"entered_by" text,
	"supersedes" text,
	"reason" text,
	CONSTRAINT "icu_chart_values_source_ck" CHECK ("icu_chart_values"."source" in ('device', 'manual', 'correction')),
	CONSTRAINT "icu_chart_values_correction_ck" CHECK (("icu_chart_values"."source" = 'correction') = ("icu_chart_values"."supersedes" is not null and "icu_chart_values"."reason" is not null)),
	CONSTRAINT "icu_chart_values_technical_ck" CHECK ("icu_chart_values"."technical" is null or "icu_chart_values"."value" is null)
);
--> statement-breakpoint
CREATE TABLE "icu_device_links" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"device_type" text NOT NULL,
	"bed_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"linked_by" text NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	"end_reason" text,
	CONSTRAINT "icu_device_links_type_ck" CHECK ("icu_device_links"."device_type" in ('monitor', 'ventilator', 'pump')),
	CONSTRAINT "icu_device_links_end_ck" CHECK (("icu_device_links"."ended_at" is null) = ("icu_device_links"."end_reason" is null)),
	CONSTRAINT "icu_device_links_reason_ck" CHECK ("icu_device_links"."end_reason" is null or "icu_device_links"."end_reason" in ('unlinked', 'transfer', 'discharge', 'death', 'bed_change'))
);
--> statement-breakpoint
CREATE TABLE "icu_family_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"ist_day" text NOT NULL,
	"summary" text NOT NULL,
	"given_to" text NOT NULL,
	"relation" text NOT NULL,
	"mode" text NOT NULL,
	"given_by" text NOT NULL,
	"given_at" timestamp with time zone NOT NULL,
	CONSTRAINT "icu_family_updates_mode_ck" CHECK ("icu_family_updates"."mode" in ('in_person', 'phone', 'video'))
);
--> statement-breakpoint
CREATE TABLE "icu_feed_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"gateway_id" text NOT NULL,
	"batch_ref" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"skew_ms" integer NOT NULL,
	"drift_flagged" boolean NOT NULL,
	"outcome" jsonb NOT NULL,
	"quarantine" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "icu_feed_gaps" (
	"id" text PRIMARY KEY NOT NULL,
	"gateway_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "icu_gateway_codes" (
	"gateway_id" text NOT NULL,
	"code" text NOT NULL,
	"param" text NOT NULL,
	"unit" text,
	CONSTRAINT "icu_gateway_codes_gateway_id_code_pk" PRIMARY KEY("gateway_id","code")
);
--> statement-breakpoint
CREATE TABLE "icu_gateways" (
	"id" text PRIMARY KEY NOT NULL,
	"hall_id" text NOT NULL,
	"name" text NOT NULL,
	"agent_id" text NOT NULL,
	"interface_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "icu_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"kind" text NOT NULL,
	"site" text NOT NULL,
	"inserted_at" timestamp with time zone NOT NULL,
	"inserted_by" text NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	CONSTRAINT "icu_lines_kind_ck" CHECK ("icu_lines"."kind" in ('central_line', 'arterial_line', 'urinary_catheter', 'endotracheal_tube'))
);
--> statement-breakpoint
CREATE TABLE "icu_numerics" (
	"id" bigserial NOT NULL,
	"gateway_id" text NOT NULL,
	"slot" text NOT NULL,
	"bed_id" text,
	"link_id" text,
	"admission_id" text,
	"param" text NOT NULL,
	"value" double precision,
	"technical" text,
	"device_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "icu_numerics_id_observed_at_pk" PRIMARY KEY("id","observed_at")
) PARTITION BY RANGE ("observed_at");
--> statement-breakpoint
CREATE TABLE "icu_numerics_minute" (
	"admission_id" text NOT NULL,
	"param" text NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"value" double precision NOT NULL,
	CONSTRAINT "icu_numerics_minute_admission_id_param_minute_pk" PRIMARY KEY("admission_id","param","minute")
);
--> statement-breakpoint
CREATE TABLE "icu_request_events" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"act" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "icu_request_events_act_ck" CHECK ("icu_request_events"."act" in ('raised', 'approved', 'refused', 'held', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "icu_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"admission_id" text,
	"source" text NOT NULL,
	"priority_class" integer NOT NULL,
	"triage" jsonb NOT NULL,
	"reason" text NOT NULL,
	"state" text NOT NULL,
	"approval_id" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"review_at" timestamp with time zone,
	"monitoring" text,
	CONSTRAINT "icu_requests_source_ck" CHECK ("icu_requests"."source" in ('er', 'ward', 'ot')),
	CONSTRAINT "icu_requests_priority_ck" CHECK ("icu_requests"."priority_class" between 1 and 4),
	CONSTRAINT "icu_requests_state_ck" CHECK ("icu_requests"."state" in ('pending', 'on_hold', 'approved', 'refused', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "icu_slots" (
	"gateway_id" text NOT NULL,
	"slot" text NOT NULL,
	"bed_id" text NOT NULL,
	CONSTRAINT "icu_slots_gateway_id_slot_pk" PRIMARY KEY("gateway_id","slot")
);
--> statement-breakpoint
CREATE TABLE "icu_visit_slots" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"visitor_name" text NOT NULL,
	"relation" text NOT NULL,
	"logged_by" text NOT NULL,
	"logged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "icu_visit_slots_span_ck" CHECK ("icu_visit_slots"."starts_at" < "icu_visit_slots"."ends_at")
);
--> statement-breakpoint
ALTER TABLE "icu_alarm_events" ADD CONSTRAINT "icu_alarm_events_alarm_id_icu_alarms_id_fk" FOREIGN KEY ("alarm_id") REFERENCES "public"."icu_alarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_alarm_limits" ADD CONSTRAINT "icu_alarm_limits_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_alarms" ADD CONSTRAINT "icu_alarms_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_alarms" ADD CONSTRAINT "icu_alarms_bed_id_resources_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_bundles" ADD CONSTRAINT "icu_bundles_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_chart_hours" ADD CONSTRAINT "icu_chart_hours_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_chart_values" ADD CONSTRAINT "icu_chart_values_hour_id_icu_chart_hours_id_fk" FOREIGN KEY ("hour_id") REFERENCES "public"."icu_chart_hours"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_device_links" ADD CONSTRAINT "icu_device_links_device_id_resources_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_device_links" ADD CONSTRAINT "icu_device_links_bed_id_resources_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_device_links" ADD CONSTRAINT "icu_device_links_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_device_links" ADD CONSTRAINT "icu_device_links_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_family_updates" ADD CONSTRAINT "icu_family_updates_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_feed_batches" ADD CONSTRAINT "icu_feed_batches_gateway_id_icu_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."icu_gateways"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_feed_gaps" ADD CONSTRAINT "icu_feed_gaps_gateway_id_icu_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."icu_gateways"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_gateway_codes" ADD CONSTRAINT "icu_gateway_codes_gateway_id_icu_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."icu_gateways"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_gateways" ADD CONSTRAINT "icu_gateways_hall_id_resources_id_fk" FOREIGN KEY ("hall_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_gateways" ADD CONSTRAINT "icu_gateways_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_gateways" ADD CONSTRAINT "icu_gateways_interface_id_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."interfaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_lines" ADD CONSTRAINT "icu_lines_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_numerics_minute" ADD CONSTRAINT "icu_numerics_minute_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_request_events" ADD CONSTRAINT "icu_request_events_request_id_icu_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."icu_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_requests" ADD CONSTRAINT "icu_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_requests" ADD CONSTRAINT "icu_requests_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_slots" ADD CONSTRAINT "icu_slots_gateway_id_icu_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."icu_gateways"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_slots" ADD CONSTRAINT "icu_slots_bed_id_resources_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icu_visit_slots" ADD CONSTRAINT "icu_visit_slots_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "icu_alarm_events_alarm_idx" ON "icu_alarm_events" USING btree ("alarm_id","at");--> statement-breakpoint
CREATE INDEX "icu_alarm_events_storm_idx" ON "icu_alarm_events" USING btree ("admission_id","act","at");--> statement-breakpoint
CREATE INDEX "icu_alarm_limits_admission_idx" ON "icu_alarm_limits" USING btree ("admission_id","param");--> statement-breakpoint
CREATE INDEX "icu_alarms_open_idx" ON "icu_alarms" USING btree ("state","rung_since");--> statement-breakpoint
CREATE INDEX "icu_alarms_admission_idx" ON "icu_alarms" USING btree ("admission_id","raised_at");--> statement-breakpoint
CREATE UNIQUE INDEX "icu_bundles_open_ux" ON "icu_bundles" USING btree ("admission_id","kind") WHERE "icu_bundles"."done_at" is null;--> statement-breakpoint
CREATE INDEX "icu_bundles_due_idx" ON "icu_bundles" USING btree ("due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "icu_chart_hours_ux" ON "icu_chart_hours" USING btree ("admission_id","hour_start");--> statement-breakpoint
CREATE INDEX "icu_chart_values_hour_idx" ON "icu_chart_values" USING btree ("hour_id","param");--> statement-breakpoint
CREATE UNIQUE INDEX "icu_chart_values_supersedes_ux" ON "icu_chart_values" USING btree ("supersedes");--> statement-breakpoint
CREATE UNIQUE INDEX "icu_device_links_device_open_ux" ON "icu_device_links" USING btree ("device_id") WHERE "icu_device_links"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "icu_device_links_bed_type_open_ux" ON "icu_device_links" USING btree ("bed_id","device_type") WHERE "icu_device_links"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "icu_device_links_admission_idx" ON "icu_device_links" USING btree ("admission_id","linked_at");--> statement-breakpoint
CREATE INDEX "icu_family_updates_admission_idx" ON "icu_family_updates" USING btree ("admission_id","given_at");--> statement-breakpoint
CREATE UNIQUE INDEX "icu_feed_batches_ref_ux" ON "icu_feed_batches" USING btree ("gateway_id","batch_ref");--> statement-breakpoint
CREATE INDEX "icu_feed_batches_received_idx" ON "icu_feed_batches" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "icu_feed_gaps_open_ux" ON "icu_feed_gaps" USING btree ("gateway_id") WHERE "icu_feed_gaps"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "icu_gateways_hall_ux" ON "icu_gateways" USING btree ("hall_id") WHERE "icu_gateways"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "icu_gateways_interface_ux" ON "icu_gateways" USING btree ("interface_id");--> statement-breakpoint
CREATE INDEX "icu_lines_admission_idx" ON "icu_lines" USING btree ("admission_id");--> statement-breakpoint
CREATE INDEX "icu_numerics_admission_idx" ON "icu_numerics" USING btree ("admission_id","param","observed_at");--> statement-breakpoint
CREATE INDEX "icu_numerics_bed_idx" ON "icu_numerics" USING btree ("bed_id","observed_at");--> statement-breakpoint
CREATE INDEX "icu_request_events_request_idx" ON "icu_request_events" USING btree ("request_id","at");--> statement-breakpoint
CREATE INDEX "icu_requests_state_idx" ON "icu_requests" USING btree ("state","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "icu_requests_open_ux" ON "icu_requests" USING btree ("patient_id") WHERE "icu_requests"."state" in ('pending', 'on_hold');--> statement-breakpoint
CREATE UNIQUE INDEX "icu_slots_bed_ux" ON "icu_slots" USING btree ("bed_id");--> statement-breakpoint
CREATE INDEX "icu_visit_slots_admission_idx" ON "icu_visit_slots" USING btree ("admission_id","starts_at");