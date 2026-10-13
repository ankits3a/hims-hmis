CREATE TABLE "ipd_bed_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"bed_id" text NOT NULL,
	"bed_code" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"outcome_bed_id" text,
	"withdraw_reason" text,
	CONSTRAINT "ipd_bed_proposals_outcome_ck" CHECK ("ipd_bed_proposals"."outcome" is null or "ipd_bed_proposals"."outcome" in ('accepted', 'overridden', 'withdrawn')),
	CONSTRAINT "ipd_bed_proposals_ended_ck" CHECK (("ipd_bed_proposals"."outcome" is null) = ("ipd_bed_proposals"."ended_at" is null)),
	CONSTRAINT "ipd_bed_proposals_withdrawn_ck" CHECK (("ipd_bed_proposals"."outcome" = 'withdrawn') = ("ipd_bed_proposals"."withdraw_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "ipd_bed_proposals" ADD CONSTRAINT "ipd_bed_proposals_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_bed_proposals" ADD CONSTRAINT "ipd_bed_proposals_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_bed_proposals" ADD CONSTRAINT "ipd_bed_proposals_bed_id_resources_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_bed_proposals_open_admission_ux" ON "ipd_bed_proposals" USING btree ("admission_id") WHERE "ipd_bed_proposals"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "ipd_bed_proposals_ended_idx" ON "ipd_bed_proposals" USING btree ("ended_at");