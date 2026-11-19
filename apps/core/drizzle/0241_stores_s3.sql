CREATE TABLE "stores_nudges" (
	"indent_id" text NOT NULL,
	"step" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"recipients" jsonb NOT NULL,
	CONSTRAINT "stores_nudges_indent_id_step_pk" PRIMARY KEY("indent_id","step"),
	CONSTRAINT "stores_nudges_step_ck" CHECK ("stores_nudges"."step" in ('approval', 'pick') or "stores_nudges"."step" ~ '^leg:[0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "stores_nudges" ADD CONSTRAINT "stores_nudges_indent_id_store_indents_id_fk" FOREIGN KEY ("indent_id") REFERENCES "public"."store_indents"("id") ON DELETE no action ON UPDATE no action;