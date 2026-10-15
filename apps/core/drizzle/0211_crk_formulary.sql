CREATE TABLE "formulary_monograph_signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"monograph_id" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"signed_by" text NOT NULL,
	"designation" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"crk" jsonb NOT NULL,
	CONSTRAINT "formulary_monograph_signatures_kind_ck" CHECK ("formulary_monograph_signatures"."kind" in ('sole', 'first', 'second'))
);
--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "crk" jsonb;--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "drafted_model" text;--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "drafted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "draft_usage" jsonb;--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "high_alert" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "first_signed_by" text;--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "first_signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "first_signer_designation" text;--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "reviewer_designation" text;--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "second_reviewed_by" text;--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "second_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "second_reviewer_designation" text;--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "review_due_on" date;--> statement-breakpoint
ALTER TABLE "formulary_monographs" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "formulary_monograph_signatures" ADD CONSTRAINT "formulary_monograph_signatures_monograph_id_formulary_monographs_id_fk" FOREIGN KEY ("monograph_id") REFERENCES "public"."formulary_monographs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "formulary_monograph_signatures_monograph_idx" ON "formulary_monograph_signatures" USING btree ("monograph_id","signed_at");