CREATE TABLE "ipd_admission_deposits" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"receipt_no" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"tender" text NOT NULL,
	"payer_name" text NOT NULL,
	"payer_relation" text NOT NULL,
	"payer_phone" text,
	"non_covered_approval_id" text,
	"taken_by" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_admission_deposits_amount_ck" CHECK ("ipd_admission_deposits"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "ipd_admissions" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text NOT NULL,
	"workflow_instance_id" text NOT NULL,
	"state" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"consultant_id" text NOT NULL,
	"covering_for" text,
	"department" text,
	"requested_class" text NOT NULL,
	"isolation" text NOT NULL,
	"icu" boolean NOT NULL,
	"place_as" text,
	"provisional_diagnosis" text,
	"mlc" boolean DEFAULT false NOT NULL,
	"planned_for" timestamp with time zone,
	"requested_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"requested_by" text NOT NULL,
	"payer_kind" text,
	"coverage_id" text,
	"plan_kind" text,
	"procedure_estimate_paise" bigint,
	"estimate_paise" bigint,
	"deposit_required_paise" bigint,
	"deposit_basis" text,
	"deposit_exemption" text,
	"deposit_exemption_approval_id" text,
	"consent" jsonb,
	"consent_at" timestamp with time zone,
	"icu_approval_id" text,
	"admission_year" integer,
	"admission_serial" integer,
	"admission_no" text,
	"admitted_at" timestamp with time zone,
	"admitted_by" text,
	"stabilised_at" timestamp with time zone,
	"downtime_serial" text,
	"paper_receipt_no" text,
	"cancel_reason" text,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_admissions_source_ck" CHECK ("ipd_admissions"."source" in ('opd_advice', 'ot_daycare_conversion', 'er', 'direct', 'transfer_in', 'downtime')),
	CONSTRAINT "ipd_admissions_payer_ck" CHECK ("ipd_admissions"."payer_kind" is null or "ipd_admissions"."payer_kind" in ('cash', 'insurance_cashless', 'insurance_reimbursement', 'pmjay', 'state_scheme', 'corporate')),
	CONSTRAINT "ipd_admissions_money_ck" CHECK (coalesce("ipd_admissions"."estimate_paise", 0) >= 0 and coalesce("ipd_admissions"."deposit_required_paise", 0) >= 0 and coalesce("ipd_admissions"."procedure_estimate_paise", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "ipd_bands" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
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
	CONSTRAINT "ipd_bands_status_ck" CHECK ("ipd_bands"."status" in ('printed', 'void'))
);
--> statement-breakpoint
CREATE TABLE "ipd_payer_auths" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"payer_kind" text NOT NULL,
	"payer_ref" text,
	"entry" text NOT NULL,
	"pre_auth_number" text,
	"status" text NOT NULL,
	"approved_amount_paise" bigint,
	"approved_total_paise" bigint NOT NULL,
	"covers_from" timestamp with time zone,
	"provisional_cashless_signed" boolean NOT NULL,
	"counselling_document_id" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_payer_auths_entry_ck" CHECK ("ipd_payer_auths"."entry" in ('initial', 'enhancement', 'final', 'denial', 'payer_change')),
	CONSTRAINT "ipd_payer_auths_status_ck" CHECK ("ipd_payer_auths"."status" in ('requested', 'approved', 'partially_approved', 'denied', 'final_approved'))
);
--> statement-breakpoint
ALTER TABLE "ipd_admission_deposits" ADD CONSTRAINT "ipd_admission_deposits_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_bands" ADD CONSTRAINT "ipd_bands_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_payer_auths" ADD CONSTRAINT "ipd_payer_auths_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_admission_deposits_receipt_ux" ON "ipd_admission_deposits" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "ipd_admission_deposits_admission_idx" ON "ipd_admission_deposits" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_admissions_open_patient_ux" ON "ipd_admissions" USING btree ("patient_id") WHERE "ipd_admissions"."state" in ('requested', 'reserved', 'admitted', 'transferring', 'fit_declared', 'discharging');--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_admissions_no_ux" ON "ipd_admissions" USING btree ("admission_no") WHERE "ipd_admissions"."admission_no" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_admissions_serial_ux" ON "ipd_admissions" USING btree ("admission_year","admission_serial") WHERE "ipd_admissions"."admission_serial" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_admissions_downtime_serial_ux" ON "ipd_admissions" USING btree ("downtime_serial") WHERE "ipd_admissions"."downtime_serial" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_admissions_instance_ux" ON "ipd_admissions" USING btree ("workflow_instance_id");--> statement-breakpoint
CREATE INDEX "ipd_admissions_state_idx" ON "ipd_admissions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "ipd_admissions_patient_idx" ON "ipd_admissions" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_bands_serial_ux" ON "ipd_bands" USING btree ("serial");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_bands_live_admission_ux" ON "ipd_bands" USING btree ("admission_id") WHERE "ipd_bands"."status" = 'printed';--> statement-breakpoint
CREATE INDEX "ipd_payer_auths_admission_idx" ON "ipd_payer_auths" USING btree ("admission_id","recorded_at");