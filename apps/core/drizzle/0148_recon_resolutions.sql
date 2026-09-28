CREATE TABLE "recon_resolutions" (
	"id" text PRIMARY KEY NOT NULL,
	"tender_id" text NOT NULL,
	"outcome" text NOT NULL,
	"short_paise" bigint NOT NULL,
	"settled_paise" bigint NOT NULL,
	"reason" text NOT NULL,
	"approval_id" text,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "recon_resolutions_outcome_ck" CHECK ("recon_resolutions"."outcome" in ('disputed', 'bank_charge', 'reupload'))
);
--> statement-breakpoint
ALTER TABLE "recon_resolutions" ADD CONSTRAINT "recon_resolutions_tender_id_receipt_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."receipt_tenders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recon_resolutions_tender_idx" ON "recon_resolutions" USING btree ("tender_id");