CREATE TABLE "allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"receipt_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"kind" text NOT NULL,
	"reversal_of_id" text,
	"reason" text,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_config" (
	"id" text PRIMARY KEY NOT NULL,
	"cash_warn_paise" bigint NOT NULL,
	"cash_block_paise" bigint NOT NULL,
	"pan_threshold_paise" bigint NOT NULL,
	"refund_bank_above_paise" bigint NOT NULL,
	"credit_cap_paise" bigint NOT NULL,
	"outstanding_cap_paise" bigint NOT NULL,
	"outstanding_cap_mode" text DEFAULT 'warn' NOT NULL,
	"fee_bps" jsonb NOT NULL,
	"recon_tolerance_paise" bigint NOT NULL,
	"series_prefixes" jsonb NOT NULL,
	"charge_rules" jsonb NOT NULL,
	"degraded_tender" boolean DEFAULT false NOT NULL,
	"ca_signed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cashier_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"cashier_user_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opening_float_paise" bigint NOT NULL,
	"denominations" jsonb,
	"counted_cash_paise" bigint,
	"expected_cash_paise" bigint,
	"variance_paise" bigint,
	"variance_approval_id" text,
	"close_note" text,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_note_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"credit_note_id" text NOT NULL,
	"invoice_line_id" text NOT NULL,
	"qty" integer NOT NULL,
	"gross_paise" bigint NOT NULL,
	"discount_paise" bigint NOT NULL,
	"taxable_base_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"credit_note_no" text NOT NULL,
	"invoice_id" text NOT NULL,
	"kind" text NOT NULL,
	"discount_category" text,
	"reason" text NOT NULL,
	"approval_id" text,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"gross_paise" bigint NOT NULL,
	"discount_paise" bigint NOT NULL,
	"taxable_base_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"rounding_paise" bigint NOT NULL,
	"net_paise" bigint NOT NULL,
	CONSTRAINT "credit_notes_credit_note_no_unique" UNIQUE("credit_note_no")
);
--> statement-breakpoint
CREATE TABLE "daily_closes" (
	"day" date PRIMARY KEY NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"totals" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_series" (
	"series_key" text NOT NULL,
	"fy" text NOT NULL,
	"next_no" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "document_series_series_key_fy_pk" PRIMARY KEY("series_key","fy")
);
--> statement-breakpoint
CREATE TABLE "entered_in_error_marks" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_type" text NOT NULL,
	"doc_id" text NOT NULL,
	"reason" text NOT NULL,
	"marked_by" text NOT NULL,
	"marked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"service_id" text NOT NULL,
	"service_name" text NOT NULL,
	"category" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_paise" bigint NOT NULL,
	"gross_paise" bigint NOT NULL,
	"regulated_clamp" jsonb,
	"candidates" jsonb NOT NULL,
	"winner" jsonb,
	"discount_paise" bigint NOT NULL,
	"taxable_base_paise" bigint NOT NULL,
	"sac_code" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"exempt" boolean NOT NULL,
	"exempt_reason" text,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"net_paise" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_no" text NOT NULL,
	"patient_id" text NOT NULL,
	"encounter_id" text,
	"tariff_version_id" text NOT NULL,
	"intended_payer" text DEFAULT 'self' NOT NULL,
	"buyer_gstin" text,
	"buyer_legal_name" text,
	"gross_paise" bigint NOT NULL,
	"discount_paise" bigint NOT NULL,
	"taxable_base_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"raw_total_paise" bigint NOT NULL,
	"rounding_paise" bigint NOT NULL,
	"net_payable_paise" bigint NOT NULL,
	"credit_extended" boolean DEFAULT false NOT NULL,
	"credit_reason" text,
	"credit_approval_id" text,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"service_day" date NOT NULL,
	"seq" bigserial NOT NULL,
	CONSTRAINT "invoices_invoice_no_unique" UNIQUE("invoice_no")
);
--> statement-breakpoint
CREATE TABLE "receipt_tenders" (
	"id" text PRIMARY KEY NOT NULL,
	"receipt_id" text NOT NULL,
	"mode" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"ref_text" text,
	"state" text DEFAULT 'captured' NOT NULL,
	"expected_net_paise" bigint,
	"settled_paise" bigint,
	"reconciled_at" timestamp with time zone,
	"mismatch_note" text
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"receipt_no" text NOT NULL,
	"patient_id" text NOT NULL,
	"cashier_session_id" text NOT NULL,
	"received_by" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"service_day" date NOT NULL,
	"total_paise" bigint NOT NULL,
	"pan_number" text,
	"form60" boolean DEFAULT false NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"note" text,
	"seq" bigserial NOT NULL,
	CONSTRAINT "receipts_receipt_no_unique" UNIQUE("receipt_no")
);
--> statement-breakpoint
CREATE TABLE "recon_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"rows_total" integer NOT NULL,
	"rows_matched" integer NOT NULL,
	"rows_mismatched" integer NOT NULL,
	"rows_unmatched" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_vouchers" (
	"id" text PRIMARY KEY NOT NULL,
	"voucher_no" text NOT NULL,
	"patient_id" text NOT NULL,
	"kind" text NOT NULL,
	"credit_note_id" text,
	"invoice_id" text,
	"amount_paise" bigint NOT NULL,
	"method" text NOT NULL,
	"payee_name" text,
	"payee_id_type" text,
	"payee_id_ref" text,
	"reason_class" text NOT NULL,
	"reason" text NOT NULL,
	"guard_flags" jsonb NOT NULL,
	"approval_id" text NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"requested_by" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"paid_by" text,
	"paid_at" timestamp with time zone,
	"cashier_session_id" text,
	CONSTRAINT "refund_vouchers_voucher_no_unique" UNIQUE("voucher_no")
);
--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_tenders" ADD CONSTRAINT "receipt_tenders_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_cashier_session_id_cashier_sessions_id_fk" FOREIGN KEY ("cashier_session_id") REFERENCES "public"."cashier_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_vouchers" ADD CONSTRAINT "refund_vouchers_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cashier_sessions_live_ux" ON "cashier_sessions" USING btree ("cashier_user_id") WHERE "cashier_sessions"."status" in ('open', 'closing');--> statement-breakpoint
CREATE UNIQUE INDEX "entered_in_error_marks_doc_ux" ON "entered_in_error_marks" USING btree ("doc_type","doc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_invoice_line_no" ON "invoice_lines" USING btree ("invoice_id","line_no");