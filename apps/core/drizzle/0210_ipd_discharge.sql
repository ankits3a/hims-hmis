CREATE TABLE "ipd_discharge_confirmations" (
	"id" text PRIMARY KEY NOT NULL,
	"discharge_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"department" text NOT NULL,
	"basis" text NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "ipd_discharge_confirmations_dept_ck" CHECK ("ipd_discharge_confirmations"."department" in ('pharmacy', 'lab', 'radiology', 'ot', 'ward', 'dietary', 'cssd', 'blood_bank', 'billing')),
	CONSTRAINT "ipd_discharge_confirmations_basis_ck" CHECK ("ipd_discharge_confirmations"."basis" in ('lines', 'open_orders', 'always')),
	CONSTRAINT "ipd_discharge_confirmations_by_ck" CHECK (("ipd_discharge_confirmations"."confirmed_by" is null) = ("ipd_discharge_confirmations"."confirmed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "ipd_discharge_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"status" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"draft_source" text NOT NULL,
	"draft_model_id" text,
	"draft_prompt_version" text,
	"drafted_by" text NOT NULL,
	"drafted_at" timestamp with time zone NOT NULL,
	"resident_signed_by" text,
	"resident_signed_at" timestamp with time zone,
	"signed_by" text,
	"signed_at" timestamp with time zone,
	"document_id" text,
	CONSTRAINT "ipd_discharge_summaries_status_ck" CHECK ("ipd_discharge_summaries"."status" in ('draft', 'awaiting_cosign', 'signed')),
	CONSTRAINT "ipd_discharge_summaries_source_ck" CHECK ("ipd_discharge_summaries"."draft_source" in ('person', 'copilot_draft')),
	CONSTRAINT "ipd_discharge_summaries_signed_ck" CHECK (("ipd_discharge_summaries"."status" = 'signed') = ("ipd_discharge_summaries"."signed_at" is not null)),
	CONSTRAINT "ipd_discharge_summaries_version_ck" CHECK ("ipd_discharge_summaries"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "ipd_discharges" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"status" text NOT NULL,
	"fit_when" text NOT NULL,
	"disposition" text NOT NULL,
	"note" text,
	"declared_by" text NOT NULL,
	"declared_at" timestamp with time zone NOT NULL,
	"target_at" timestamp with time zone NOT NULL,
	"ended_by" text,
	"ended_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "ipd_discharges_status_ck" CHECK ("ipd_discharges"."status" in ('active', 'completed', 'cancelled')),
	CONSTRAINT "ipd_discharges_when_ck" CHECK ("ipd_discharges"."fit_when" in ('today', 'tomorrow')),
	CONSTRAINT "ipd_discharges_disposition_ck" CHECK ("ipd_discharges"."disposition" in ('home', 'transfer_out')),
	CONSTRAINT "ipd_discharges_ended_ck" CHECK (("ipd_discharges"."status" = 'active') = ("ipd_discharges"."ended_at" is null)),
	CONSTRAINT "ipd_discharges_cancel_ck" CHECK (("ipd_discharges"."status" = 'cancelled') = ("ipd_discharges"."cancel_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "ipd_final_bills" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"bill_version" integer NOT NULL,
	"invoice_id" text,
	"invoice_no" text,
	"total_paise" bigint NOT NULL,
	"payer_paise" bigint NOT NULL,
	"patient_paise" bigint NOT NULL,
	"deposit_applied_paise" bigint NOT NULL,
	"paid_paise" bigint NOT NULL,
	"refund_paise" bigint NOT NULL,
	"refund_approval_id" text,
	"dues_paise" bigint NOT NULL,
	"settlement" text NOT NULL,
	"dues_approval_id" text,
	"dues_approved_by" text,
	"dues_approved_at" timestamp with time zone,
	"undertaking_document_id" text,
	"split" jsonb NOT NULL,
	"settled_by" text NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_final_bills_settlement_ck" CHECK ("ipd_final_bills"."settlement" in ('paid', 'refund_due', 'dues_recorded', 'insurer_pending_undertaking')),
	CONSTRAINT "ipd_final_bills_money_ck" CHECK ("ipd_final_bills"."total_paise" >= 0 and "ipd_final_bills"."payer_paise" >= 0 and "ipd_final_bills"."patient_paise" >= 0 and "ipd_final_bills"."deposit_applied_paise" >= 0 and "ipd_final_bills"."paid_paise" >= 0 and "ipd_final_bills"."refund_paise" >= 0 and "ipd_final_bills"."dues_paise" >= 0),
	CONSTRAINT "ipd_final_bills_dues_ck" CHECK ("ipd_final_bills"."dues_paise" = 0 or "ipd_final_bills"."undertaking_document_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "ipd_gate_passes" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"dues_recorded" boolean NOT NULL,
	"receiving_hospital" jsonb,
	"follow_up_appointment_id" text,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"scanned_by" text,
	"scanned_at" timestamp with time zone,
	"gate_id" text,
	"voided_by" text,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "ipd_gate_passes_kind_ck" CHECK ("ipd_gate_passes"."kind" in ('discharge', 'transfer_out')),
	CONSTRAINT "ipd_gate_passes_status_ck" CHECK ("ipd_gate_passes"."status" in ('issued', 'used', 'void')),
	CONSTRAINT "ipd_gate_passes_used_ck" CHECK (("ipd_gate_passes"."status" = 'used') = ("ipd_gate_passes"."scanned_at" is not null)),
	CONSTRAINT "ipd_gate_passes_void_ck" CHECK (("ipd_gate_passes"."status" = 'void') = ("ipd_gate_passes"."voided_at" is not null)),
	CONSTRAINT "ipd_gate_passes_refer_ck" CHECK (("ipd_gate_passes"."kind" = 'transfer_out') = ("ipd_gate_passes"."receiving_hospital" is not null))
);
--> statement-breakpoint
CREATE TABLE "ipd_mortuary_register" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"status" text NOT NULL,
	"died_at" timestamp with time zone NOT NULL,
	"mlc" boolean NOT NULL,
	"received_at" timestamp with time zone,
	"received_by" text,
	"identity_checked_by" text,
	"police_clearance" boolean DEFAULT false NOT NULL,
	"police_clearance_ref" text,
	"released_to" jsonb,
	"released_at" timestamp with time zone,
	"released_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_mortuary_register_status_ck" CHECK ("ipd_mortuary_register"."status" in ('expected', 'received', 'released')),
	CONSTRAINT "ipd_mortuary_register_received_ck" CHECK (("ipd_mortuary_register"."status" = 'expected') = ("ipd_mortuary_register"."received_at" is null)),
	CONSTRAINT "ipd_mortuary_register_released_ck" CHECK (("ipd_mortuary_register"."status" = 'released') = ("ipd_mortuary_register"."released_at" is not null)),
	CONSTRAINT "ipd_mortuary_register_mlc_ck" CHECK ("ipd_mortuary_register"."status" <> 'released' or not "ipd_mortuary_register"."mlc" or "ipd_mortuary_register"."police_clearance")
);
--> statement-breakpoint
CREATE TABLE "ipd_payer_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"final_bill_id" text NOT NULL,
	"payer_kind" text NOT NULL,
	"coverage_id" text,
	"pre_auth_number" text,
	"claim_paise" bigint NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_payer_claims_status_ck" CHECK ("ipd_payer_claims"."status" in ('pending', 'filed', 'settled', 'rejected')),
	CONSTRAINT "ipd_payer_claims_money_ck" CHECK ("ipd_payer_claims"."claim_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "ipd_stay_exits" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"details" jsonb NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_stay_exits_kind_ck" CHECK ("ipd_stay_exits"."kind" in ('lama', 'dama', 'absconded', 'deceased'))
);
--> statement-breakpoint
ALTER TABLE "ipd_discharge_confirmations" ADD CONSTRAINT "ipd_discharge_confirmations_discharge_id_ipd_discharges_id_fk" FOREIGN KEY ("discharge_id") REFERENCES "public"."ipd_discharges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_discharge_confirmations" ADD CONSTRAINT "ipd_discharge_confirmations_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_discharge_summaries" ADD CONSTRAINT "ipd_discharge_summaries_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_discharges" ADD CONSTRAINT "ipd_discharges_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_final_bills" ADD CONSTRAINT "ipd_final_bills_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_gate_passes" ADD CONSTRAINT "ipd_gate_passes_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_mortuary_register" ADD CONSTRAINT "ipd_mortuary_register_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_payer_claims" ADD CONSTRAINT "ipd_payer_claims_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_payer_claims" ADD CONSTRAINT "ipd_payer_claims_final_bill_id_ipd_final_bills_id_fk" FOREIGN KEY ("final_bill_id") REFERENCES "public"."ipd_final_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_stay_exits" ADD CONSTRAINT "ipd_stay_exits_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_discharge_confirmations_ux" ON "ipd_discharge_confirmations" USING btree ("discharge_id","department");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_discharge_summaries_admission_ux" ON "ipd_discharge_summaries" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_discharges_active_ux" ON "ipd_discharges" USING btree ("admission_id") WHERE "ipd_discharges"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ipd_discharges_admission_idx" ON "ipd_discharges" USING btree ("admission_id","declared_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_final_bills_admission_ux" ON "ipd_final_bills" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_gate_passes_code_ux" ON "ipd_gate_passes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_gate_passes_live_ux" ON "ipd_gate_passes" USING btree ("admission_id") WHERE "ipd_gate_passes"."status" = 'issued';--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_mortuary_register_admission_ux" ON "ipd_mortuary_register" USING btree ("admission_id");--> statement-breakpoint
CREATE INDEX "ipd_mortuary_register_status_idx" ON "ipd_mortuary_register" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_payer_claims_admission_ux" ON "ipd_payer_claims" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_stay_exits_admission_ux" ON "ipd_stay_exits" USING btree ("admission_id");