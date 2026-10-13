CREATE TABLE "ipd_admission_conditions" (
	"admission_id" text PRIMARY KEY NOT NULL,
	"word" text,
	"set_by" text,
	"set_at" timestamp with time zone,
	"family_off_reason" text,
	"family_off_by" text,
	"family_off_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_admission_conditions_word_ck" CHECK ("ipd_admission_conditions"."word" is null or "ipd_admission_conditions"."word" in ('stable', 'improving', 'serious', 'critical')),
	CONSTRAINT "ipd_admission_conditions_off_ck" CHECK ("ipd_admission_conditions"."family_off_reason" is null or "ipd_admission_conditions"."family_off_reason" in ('psychiatric', 'hiv', 'mtp', 'pocso', 'patient_request', 'other'))
);
--> statement-breakpoint
CREATE TABLE "ipd_family_callbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"link_id" text NOT NULL,
	"text" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"note" text,
	CONSTRAINT "ipd_family_callbacks_status_ck" CHECK ("ipd_family_callbacks"."status" in ('open', 'done')),
	CONSTRAINT "ipd_family_callbacks_closed_ck" CHECK (("ipd_family_callbacks"."status" = 'done') = ("ipd_family_callbacks"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "ipd_family_links" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"attendant_kind" text NOT NULL,
	"attendant_ref" text NOT NULL,
	"phone_hash" text NOT NULL,
	"phone_masked" text NOT NULL,
	"purpose" text NOT NULL,
	"consent" jsonb NOT NULL,
	"status" text NOT NULL,
	"issued_by" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"revoked_by" text,
	CONSTRAINT "ipd_family_links_status_ck" CHECK ("ipd_family_links"."status" in ('active', 'revoked', 'expired')),
	CONSTRAINT "ipd_family_links_kind_ck" CHECK ("ipd_family_links"."attendant_kind" in ('guardian', 'deposit_payer')),
	CONSTRAINT "ipd_family_links_revoked_ck" CHECK (("ipd_family_links"."status" = 'active') = ("ipd_family_links"."revoked_at" is null))
);
--> statement-breakpoint
CREATE TABLE "ipd_family_otps" (
	"id" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"device_hash" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ipd_family_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"device_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ipd_admission_conditions" ADD CONSTRAINT "ipd_admission_conditions_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_family_callbacks" ADD CONSTRAINT "ipd_family_callbacks_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_family_callbacks" ADD CONSTRAINT "ipd_family_callbacks_link_id_ipd_family_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."ipd_family_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_family_links" ADD CONSTRAINT "ipd_family_links_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_family_links" ADD CONSTRAINT "ipd_family_links_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_family_otps" ADD CONSTRAINT "ipd_family_otps_link_id_ipd_family_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."ipd_family_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_family_sessions" ADD CONSTRAINT "ipd_family_sessions_link_id_ipd_family_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."ipd_family_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ipd_family_callbacks_open_idx" ON "ipd_family_callbacks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ipd_family_callbacks_admission_idx" ON "ipd_family_callbacks" USING btree ("admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_family_links_token_ux" ON "ipd_family_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_family_links_live_ux" ON "ipd_family_links" USING btree ("admission_id") WHERE "ipd_family_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ipd_family_otps_link_idx" ON "ipd_family_otps" USING btree ("link_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_family_sessions_token_ux" ON "ipd_family_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ipd_family_sessions_link_idx" ON "ipd_family_sessions" USING btree ("link_id");