CREATE TABLE "pharmacy_authorisations" (
	"id" text PRIMARY KEY NOT NULL,
	"dispense_id" text NOT NULL,
	"line_idx" integer NOT NULL,
	"book" text NOT NULL,
	"about" text NOT NULL,
	"prescriber_user_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"request_note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	CONSTRAINT "pharmacy_authorisations_book_ck" CHECK ("pharmacy_authorisations"."book" in ('allergy', 'interaction', 'duplicate', 'drug_disease')),
	CONSTRAINT "pharmacy_authorisations_status_ck" CHECK ("pharmacy_authorisations"."status" in ('pending', 'authorised', 'declined')),
	CONSTRAINT "pharmacy_authorisations_decided_ck" CHECK (("pharmacy_authorisations"."status" = 'pending') = ("pharmacy_authorisations"."decided_by" is null and "pharmacy_authorisations"."decided_at" is null and "pharmacy_authorisations"."decision_reason" is null)),
	CONSTRAINT "pharmacy_authorisations_reason_ck" CHECK ("pharmacy_authorisations"."decision_reason" is null or length(btrim("pharmacy_authorisations"."decision_reason")) >= 3),
	CONSTRAINT "pharmacy_authorisations_same_actor_ck" CHECK ("pharmacy_authorisations"."decided_by" is null or "pharmacy_authorisations"."decided_by" <> "pharmacy_authorisations"."requested_by")
);
--> statement-breakpoint
ALTER TABLE "pharmacy_authorisations" ADD CONSTRAINT "pharmacy_authorisations_dispense_id_pharmacy_dispenses_id_fk" FOREIGN KEY ("dispense_id") REFERENCES "public"."pharmacy_dispenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pharmacy_authorisations_prescriber_idx" ON "pharmacy_authorisations" USING btree ("prescriber_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_authorisations_one_open_ux" ON "pharmacy_authorisations" USING btree ("dispense_id","line_idx","book","about") WHERE "pharmacy_authorisations"."status" = 'pending';