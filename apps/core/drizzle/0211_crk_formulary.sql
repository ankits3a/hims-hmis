CREATE TABLE "formulary_crk_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"generic_id" text NOT NULL,
	"signed_crk" jsonb,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"reviewer_designation" text,
	"second_reviewed_by" text,
	"second_reviewed_at" timestamp with time zone,
	"second_reviewer_designation" text,
	"review_due_on" date,
	"version" integer DEFAULT 0 NOT NULL,
	"draft_crk" jsonb,
	"drafted_model" text,
	"drafted_at" timestamp with time zone,
	"draft_usage" jsonb,
	"model_drafts" integer DEFAULT 0 NOT NULL,
	"model_input_tokens" integer DEFAULT 0 NOT NULL,
	"model_output_tokens" integer DEFAULT 0 NOT NULL,
	"high_alert" boolean DEFAULT false NOT NULL,
	"first_signed_by" text,
	"first_signed_at" timestamp with time zone,
	"first_signer_designation" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "formulary_crk_entries_text_ck" CHECK ("formulary_crk_entries"."signed_crk" is not null or "formulary_crk_entries"."draft_crk" is not null),
	CONSTRAINT "formulary_crk_entries_signed_ck" CHECK (("formulary_crk_entries"."signed_crk" is not null) = ("formulary_crk_entries"."reviewed_by" is not null) and ("formulary_crk_entries"."signed_crk" is not null) = ("formulary_crk_entries"."reviewed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "formulary_crk_signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"signed_by" text NOT NULL,
	"designation" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"crk" jsonb NOT NULL,
	CONSTRAINT "formulary_crk_signatures_kind_ck" CHECK ("formulary_crk_signatures"."kind" in ('sole', 'first', 'second', 'renewal', 'renewal_first', 'renewal_second'))
);
--> statement-breakpoint
ALTER TABLE "formulary_crk_entries" ADD CONSTRAINT "formulary_crk_entries_generic_id_formulary_generics_id_fk" FOREIGN KEY ("generic_id") REFERENCES "public"."formulary_generics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formulary_crk_signatures" ADD CONSTRAINT "formulary_crk_signatures_entry_id_formulary_crk_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."formulary_crk_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_crk_entries_generic_ux" ON "formulary_crk_entries" USING btree ("generic_id");--> statement-breakpoint
CREATE INDEX "formulary_crk_signatures_entry_idx" ON "formulary_crk_signatures" USING btree ("entry_id","signed_at");