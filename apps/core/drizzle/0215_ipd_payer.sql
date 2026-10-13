CREATE TABLE "ipd_payer_non_payables" (
	"id" text PRIMARY KEY NOT NULL,
	"match_kind" text NOT NULL,
	"match_value" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"retired_by" text,
	"retired_at" timestamp with time zone,
	CONSTRAINT "ipd_payer_non_payables_kind_ck" CHECK ("ipd_payer_non_payables"."match_kind" in ('service', 'category'))
);
--> statement-breakpoint
CREATE TABLE "ipd_payer_split_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"kind" text NOT NULL,
	"payer_paise" bigint NOT NULL,
	"patient_paise" bigint NOT NULL,
	"split" jsonb NOT NULL,
	"printed_by" text NOT NULL,
	"printed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_payer_split_snapshots_kind_ck" CHECK ("ipd_payer_split_snapshots"."kind" in ('interim'))
);
--> statement-breakpoint
ALTER TABLE "ipd_payer_auths" ADD COLUMN "room_rent_cap_paise" bigint;--> statement-breakpoint
ALTER TABLE "ipd_payer_auths" ADD COLUMN "room_rent_cap_si_bp" integer;--> statement-breakpoint
ALTER TABLE "ipd_payer_auths" ADD COLUMN "co_pay_bp" integer;--> statement-breakpoint
ALTER TABLE "ipd_payer_split_snapshots" ADD CONSTRAINT "ipd_payer_split_snapshots_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_payer_non_payables_live_ux" ON "ipd_payer_non_payables" USING btree ("match_kind",lower("match_value")) WHERE "ipd_payer_non_payables"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "ipd_payer_split_snapshots_admission_idx" ON "ipd_payer_split_snapshots" USING btree ("admission_id","printed_at");--> statement-breakpoint
ALTER TABLE "ipd_payer_auths" ADD CONSTRAINT "ipd_payer_auths_terms_ck" CHECK (("ipd_payer_auths"."room_rent_cap_paise" is null or "ipd_payer_auths"."room_rent_cap_paise" > 0)
      and ("ipd_payer_auths"."room_rent_cap_si_bp" is null or "ipd_payer_auths"."room_rent_cap_si_bp" between 1 and 10000) and ("ipd_payer_auths"."co_pay_bp" is null or "ipd_payer_auths"."co_pay_bp" between 0 and 10000));--> statement-breakpoint
ALTER TABLE "ipd_payer_auths" ADD CONSTRAINT "ipd_payer_auths_one_cap_ck" CHECK ("ipd_payer_auths"."room_rent_cap_paise" is null or "ipd_payer_auths"."room_rent_cap_si_bp" is null);