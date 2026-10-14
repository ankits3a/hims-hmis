CREATE TABLE "ipd_admission_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"package_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rate_paise" bigint NOT NULL,
	"selected_by" text NOT NULL,
	"selected_at" timestamp with time zone NOT NULL,
	"removed_by" text,
	"removed_at" timestamp with time zone,
	"removed_reason" text,
	CONSTRAINT "ipd_admission_packages_rate_ck" CHECK ("ipd_admission_packages"."rate_paise" > 0),
	CONSTRAINT "ipd_admission_packages_removed_ck" CHECK (("ipd_admission_packages"."removed_at" is null) = ("ipd_admission_packages"."removed_by" is null) and ("ipd_admission_packages"."removed_at" is null or coalesce(btrim("ipd_admission_packages"."removed_reason"), '') <> ''))
);
--> statement-breakpoint
CREATE TABLE "ipd_claim_deductions" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_event_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"reason" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"note" text,
	"line" integer NOT NULL,
	CONSTRAINT "ipd_claim_deductions_money_ck" CHECK ("ipd_claim_deductions"."amount_paise" > 0),
	CONSTRAINT "ipd_claim_deductions_reason_ck" CHECK ("ipd_claim_deductions"."reason" in ('non_payable_items', 'room_rent_cap', 'proportionate', 'co_pay', 'tariff_difference', 'over_package', 'documents_missing', 'policy_exclusion', 'other')),
	CONSTRAINT "ipd_claim_deductions_other_ck" CHECK ("ipd_claim_deductions"."reason" <> 'other' or coalesce(btrim("ipd_claim_deductions"."note"), '') <> '')
);
--> statement-breakpoint
CREATE TABLE "ipd_claim_events" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"admission_id" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"claim_ref" text,
	"claimed_paise" bigint,
	"net_paid_paise" bigint,
	"tds_paise" bigint,
	"utr_ref" text,
	"settled_on" date,
	"reason" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_claim_events_kind_ck" CHECK ("ipd_claim_events"."kind" in ('submitted', 'settled', 'short_paid', 'rejected')),
	CONSTRAINT "ipd_claim_events_submitted_ck" CHECK (("ipd_claim_events"."kind" = 'submitted') = ("ipd_claim_events"."claimed_paise" is not null)),
	CONSTRAINT "ipd_claim_events_paid_ck" CHECK (("ipd_claim_events"."kind" in ('settled', 'short_paid')) = ("ipd_claim_events"."net_paid_paise" is not null and "ipd_claim_events"."tds_paise" is not null and "ipd_claim_events"."utr_ref" is not null)),
	CONSTRAINT "ipd_claim_events_rejected_ck" CHECK ("ipd_claim_events"."kind" <> 'rejected' or coalesce(btrim("ipd_claim_events"."reason"), '') <> ''),
	CONSTRAINT "ipd_claim_events_money_ck" CHECK (coalesce("ipd_claim_events"."claimed_paise", 1) > 0 and coalesce("ipd_claim_events"."net_paid_paise", 0) >= 0 and coalesce("ipd_claim_events"."tds_paise", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "ipd_scheme_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"scheme" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"specialty" text NOT NULL,
	"kind" text NOT NULL,
	"rate_paise" bigint NOT NULL,
	"preauth_required" boolean NOT NULL,
	"import_batch" text NOT NULL,
	"imported_by" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"retired_by" text,
	"retired_at" timestamp with time zone,
	CONSTRAINT "ipd_scheme_packages_scheme_ck" CHECK ("ipd_scheme_packages"."scheme" in ('pmjay', 'state_scheme')),
	CONSTRAINT "ipd_scheme_packages_kind_ck" CHECK ("ipd_scheme_packages"."kind" in ('surgical', 'medical', 'day_care')),
	CONSTRAINT "ipd_scheme_packages_rate_ck" CHECK ("ipd_scheme_packages"."rate_paise" > 0),
	CONSTRAINT "ipd_scheme_packages_retired_ck" CHECK (("ipd_scheme_packages"."retired_at" is null) = ("ipd_scheme_packages"."retired_by" is null))
);
--> statement-breakpoint
CREATE TABLE "ipd_tpa_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"claim_id" text,
	"stage" text NOT NULL,
	"kind" text NOT NULL,
	"patient_document_id" text NOT NULL,
	"attached_by" text NOT NULL,
	"attached_at" timestamp with time zone NOT NULL,
	"detached_by" text,
	"detached_at" timestamp with time zone,
	CONSTRAINT "ipd_tpa_documents_stage_ck" CHECK ("ipd_tpa_documents"."stage" in ('preauth', 'enhancement', 'final', 'claim')),
	CONSTRAINT "ipd_tpa_documents_detached_ck" CHECK (("ipd_tpa_documents"."detached_at" is null) = ("ipd_tpa_documents"."detached_by" is null))
);
--> statement-breakpoint
CREATE TABLE "ipd_tpa_queries" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"claim_id" text,
	"stage" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"query_text" text NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"answered_by" text,
	"response_text" text,
	CONSTRAINT "ipd_tpa_queries_stage_ck" CHECK ("ipd_tpa_queries"."stage" in ('preauth', 'enhancement', 'final', 'claim')),
	CONSTRAINT "ipd_tpa_queries_claim_ck" CHECK (("ipd_tpa_queries"."stage" = 'claim') = ("ipd_tpa_queries"."claim_id" is not null)),
	CONSTRAINT "ipd_tpa_queries_answer_ck" CHECK (("ipd_tpa_queries"."answered_at" is null) = ("ipd_tpa_queries"."answered_by" is null) and ("ipd_tpa_queries"."answered_at" is null) = ("ipd_tpa_queries"."response_text" is null))
);
--> statement-breakpoint
ALTER TABLE "ipd_admission_packages" ADD CONSTRAINT "ipd_admission_packages_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_admission_packages" ADD CONSTRAINT "ipd_admission_packages_package_id_ipd_scheme_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."ipd_scheme_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_claim_deductions" ADD CONSTRAINT "ipd_claim_deductions_claim_event_id_ipd_claim_events_id_fk" FOREIGN KEY ("claim_event_id") REFERENCES "public"."ipd_claim_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_claim_deductions" ADD CONSTRAINT "ipd_claim_deductions_claim_id_ipd_payer_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."ipd_payer_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_claim_events" ADD CONSTRAINT "ipd_claim_events_claim_id_ipd_payer_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."ipd_payer_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_claim_events" ADD CONSTRAINT "ipd_claim_events_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_tpa_documents" ADD CONSTRAINT "ipd_tpa_documents_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_tpa_documents" ADD CONSTRAINT "ipd_tpa_documents_claim_id_ipd_payer_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."ipd_payer_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_tpa_queries" ADD CONSTRAINT "ipd_tpa_queries_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_tpa_queries" ADD CONSTRAINT "ipd_tpa_queries_claim_id_ipd_payer_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."ipd_payer_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_admission_packages_live_ux" ON "ipd_admission_packages" USING btree ("admission_id","code") WHERE "ipd_admission_packages"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "ipd_claim_deductions_claim_idx" ON "ipd_claim_deductions" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "ipd_claim_events_claim_idx" ON "ipd_claim_events" USING btree ("claim_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_scheme_packages_live_ux" ON "ipd_scheme_packages" USING btree ("scheme","code") WHERE "ipd_scheme_packages"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "ipd_tpa_documents_admission_idx" ON "ipd_tpa_documents" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_tpa_documents_live_ux" ON "ipd_tpa_documents" USING btree ("admission_id","stage","kind","patient_document_id") WHERE "ipd_tpa_documents"."detached_at" is null;--> statement-breakpoint
CREATE INDEX "ipd_tpa_queries_admission_idx" ON "ipd_tpa_queries" USING btree ("admission_id","raised_at");--> statement-breakpoint
CREATE INDEX "ipd_tpa_queries_open_idx" ON "ipd_tpa_queries" USING btree ("raised_at") WHERE "ipd_tpa_queries"."answered_at" is null;