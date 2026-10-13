CREATE TABLE "ipd_daily_totals" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"bill_date" date NOT NULL,
	"outcome" text NOT NULL,
	"notification_id" text,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_daily_totals_outcome_ck" CHECK ("ipd_daily_totals"."outcome" in ('queued', 'no_attendant_phone', 'sealed'))
);
--> statement-breakpoint
CREATE TABLE "ipd_deposit_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"level" text NOT NULL,
	"threshold_bp" integer NOT NULL,
	"used_bp" integer NOT NULL,
	"patient_payable_paise" bigint NOT NULL,
	"deposit_held_paise" bigint NOT NULL,
	"fired_at" timestamp with time zone NOT NULL,
	"rearmed_at" timestamp with time zone,
	CONSTRAINT "ipd_deposit_alerts_level_ck" CHECK ("ipd_deposit_alerts"."level" in ('top_up', 'escalate')),
	CONSTRAINT "ipd_deposit_alerts_money_ck" CHECK ("ipd_deposit_alerts"."patient_payable_paise" >= 0 and "ipd_deposit_alerts"."deposit_held_paise" >= 0 and "ipd_deposit_alerts"."used_bp" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ipd_daily_totals" ADD CONSTRAINT "ipd_daily_totals_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_deposit_alerts" ADD CONSTRAINT "ipd_deposit_alerts_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_daily_totals_day_ux" ON "ipd_daily_totals" USING btree ("admission_id","bill_date");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_deposit_alerts_live_ux" ON "ipd_deposit_alerts" USING btree ("admission_id","level") WHERE "ipd_deposit_alerts"."rearmed_at" is null;--> statement-breakpoint
CREATE INDEX "ipd_deposit_alerts_admission_idx" ON "ipd_deposit_alerts" USING btree ("admission_id","fired_at");