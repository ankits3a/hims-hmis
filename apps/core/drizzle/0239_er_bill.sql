-- STAGE (lane/ipd-stage): the three charge CHECKs keep #787's 'pharmacy' / 'ipd.pharmacy' (0227_ipd_drugbill) beside ER's 'er' / 'ipd.er'.
CREATE TABLE "er_advances" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"taken_by" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	CONSTRAINT "er_advances_amount_ck" CHECK ("er_advances"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "er_bills" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"settlement" text NOT NULL,
	"payer" text NOT NULL,
	"total_paise" integer NOT NULL,
	"payer_paise" integer NOT NULL,
	"patient_paise" integer NOT NULL,
	"paid_paise" integer NOT NULL,
	"dues_paise" integer NOT NULL,
	"invoice_id" text,
	"invoice_no" text,
	"undertaking" jsonb,
	"settled_by" text NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "er_bills_settlement_ck" CHECK ("er_bills"."settlement" in ('paid', 'dues', 'nothing_payable')),
	CONSTRAINT "er_bills_split_ck" CHECK ("er_bills"."payer_paise" + "er_bills"."patient_paise" = "er_bills"."total_paise"),
	CONSTRAINT "er_bills_dues_ck" CHECK (("er_bills"."settlement" = 'dues') = ("er_bills"."dues_paise" > 0))
);
--> statement-breakpoint
CREATE TABLE "er_event_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"opened_by" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "er_payer_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"payer" text NOT NULL,
	"payer_ref" text,
	"event_account_id" text,
	"amount_paise" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "er_payer_claims_payer_ck" CHECK ("er_payer_claims"."payer" in ('pmjay', 'road_accident', 'bnss_free', 'mci_event')),
	CONSTRAINT "er_payer_claims_status_ck" CHECK ("er_payer_claims"."status" in ('to_file', 'filed', 'settled', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "ipd_charge_exceptions" DROP CONSTRAINT "ipd_charge_exceptions_component_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" DROP CONSTRAINT "ipd_charge_lines_component_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" DROP CONSTRAINT "ipd_charge_lines_source_ck";--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD COLUMN "er_charge_line_id" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "payer" text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "payer_ref" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "cover_cap_paise" integer;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "cover_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "event_account_id" text;--> statement-breakpoint
ALTER TABLE "er_advances" ADD CONSTRAINT "er_advances_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_bills" ADD CONSTRAINT "er_bills_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_payer_claims" ADD CONSTRAINT "er_payer_claims_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "er_advances_episode_idx" ON "er_advances" USING btree ("episode_id");--> statement-breakpoint
CREATE UNIQUE INDEX "er_bills_episode_ux" ON "er_bills" USING btree ("episode_id");--> statement-breakpoint
CREATE UNIQUE INDEX "er_payer_claims_episode_ux" ON "er_payer_claims" USING btree ("episode_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ipd_charge_lines_er_line_ux" ON "ipd_charge_lines" USING btree ("er_charge_line_id") WHERE "ipd_charge_lines"."source" = 'ipd.er';--> statement-breakpoint
ALTER TABLE "ipd_charge_exceptions" ADD CONSTRAINT "ipd_charge_exceptions_component_ck" CHECK ("ipd_charge_exceptions"."component" is null or "ipd_charge_exceptions"."component" in ('room', 'nursing', 'rmo', 'visit', 'cross_visit', 'lab', 'imaging', 'pharmacy', 'er'));--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD CONSTRAINT "ipd_charge_lines_component_ck" CHECK ("ipd_charge_lines"."component" in ('room', 'nursing', 'rmo', 'visit', 'cross_visit', 'lab', 'imaging', 'pharmacy', 'er'));--> statement-breakpoint
ALTER TABLE "ipd_charge_lines" ADD CONSTRAINT "ipd_charge_lines_source_ck" CHECK ("ipd_charge_lines"."source" in ('ipd.nightly', 'ipd.visit', 'ipd.reversal', 'ipd.order', 'ipd.pharmacy', 'ipd.er'));--> statement-breakpoint
ALTER TABLE "er_episodes" ADD CONSTRAINT "er_episodes_payer_ck" CHECK ("er_episodes"."payer" in ('self', 'pmjay', 'road_accident', 'bnss_free', 'mci_event'));--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "accident_ref" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "accident_at" timestamp with time zone;