-- #962 Doctor Desk ward part 1: the unit stamp on an admission (written once at admit) and the append-only unit-transfer rows. Additive.
CREATE TABLE "ipd_unit_transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"admission_id" text NOT NULL,
	"from_team_id" text,
	"to_team_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipd_unit_transfers_teams_ck" CHECK ("ipd_unit_transfers"."from_team_id" is null or "ipd_unit_transfers"."from_team_id" <> "ipd_unit_transfers"."to_team_id"),
	CONSTRAINT "ipd_unit_transfers_reason_ck" CHECK (length(btrim("ipd_unit_transfers"."reason")) between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "ipd_admissions" ADD COLUMN "admitted_under_team_id" text;--> statement-breakpoint
ALTER TABLE "ipd_unit_transfers" ADD CONSTRAINT "ipd_unit_transfers_admission_id_ipd_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."ipd_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_unit_transfers" ADD CONSTRAINT "ipd_unit_transfers_from_team_id_roster_teams_id_fk" FOREIGN KEY ("from_team_id") REFERENCES "public"."roster_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipd_unit_transfers" ADD CONSTRAINT "ipd_unit_transfers_to_team_id_roster_teams_id_fk" FOREIGN KEY ("to_team_id") REFERENCES "public"."roster_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ipd_unit_transfers_admission_idx" ON "ipd_unit_transfers" USING btree ("admission_id","at");--> statement-breakpoint
CREATE INDEX "ipd_unit_transfers_to_idx" ON "ipd_unit_transfers" USING btree ("to_team_id","at");--> statement-breakpoint
CREATE INDEX "ipd_unit_transfers_from_idx" ON "ipd_unit_transfers" USING btree ("from_team_id","at");--> statement-breakpoint
ALTER TABLE "ipd_admissions" ADD CONSTRAINT "ipd_admissions_admitted_under_team_id_roster_teams_id_fk" FOREIGN KEY ("admitted_under_team_id") REFERENCES "public"."roster_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ipd_admissions_team_admitted_idx" ON "ipd_admissions" USING btree ("admitted_under_team_id","admitted_at");