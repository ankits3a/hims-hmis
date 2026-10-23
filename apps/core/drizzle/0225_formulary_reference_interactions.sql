CREATE TABLE "formulary_reference_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"salt_a_id" text NOT NULL,
	"salt_b_id" text NOT NULL,
	"drug_a_name" text NOT NULL,
	"drug_b_name" text NOT NULL,
	"ddinter_id_a" text,
	"ddinter_id_b" text,
	"level" text NOT NULL,
	"source" text NOT NULL,
	"licence" text NOT NULL,
	"retrieved_on" date NOT NULL,
	"import_batch" text NOT NULL,
	"imported_by" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by" text,
	CONSTRAINT "formulary_reference_interactions_ordered_ck" CHECK ("formulary_reference_interactions"."salt_a_id" < "formulary_reference_interactions"."salt_b_id"),
	CONSTRAINT "formulary_reference_interactions_level_ck" CHECK ("formulary_reference_interactions"."level" = 'major')
);
--> statement-breakpoint
ALTER TABLE "formulary_reference_interactions" ADD CONSTRAINT "formulary_reference_interactions_salt_a_id_formulary_salts_id_fk" FOREIGN KEY ("salt_a_id") REFERENCES "public"."formulary_salts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formulary_reference_interactions" ADD CONSTRAINT "formulary_reference_interactions_salt_b_id_formulary_salts_id_fk" FOREIGN KEY ("salt_b_id") REFERENCES "public"."formulary_salts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "formulary_reference_interactions_live_ux" ON "formulary_reference_interactions" USING btree ("salt_a_id","salt_b_id") WHERE "formulary_reference_interactions"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "formulary_reference_interactions_b_idx" ON "formulary_reference_interactions" USING btree ("salt_b_id");