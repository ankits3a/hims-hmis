CREATE TABLE "stores_audit_flag_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"flag_id" text NOT NULL,
	"verdict" text NOT NULL,
	"note" text NOT NULL,
	"confirm_id" text NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_audit_flag_reviews_ck" CHECK ("stores_audit_flag_reviews"."verdict" in ('upheld', 'dismissed') and length("stores_audit_flag_reviews"."note") > 0)
);
--> statement-breakpoint
CREATE TABLE "stores_audit_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"department_ids" text[] NOT NULL,
	"text" text NOT NULL,
	"cites" jsonb NOT NULL,
	"night" date NOT NULL,
	"raised_by" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_audit_flags_kind_ck" CHECK ("stores_audit_flags"."kind" in ('use_out_of_pattern', 'price_drift', 'split_po', 'both_ends', 'more_than_book') and length("stores_audit_flags"."text") > 0)
);
--> statement-breakpoint
ALTER TABLE "stores_audit_flag_reviews" ADD CONSTRAINT "stores_audit_flag_reviews_flag_id_stores_audit_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."stores_audit_flags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stores_audit_flag_reviews_flag_ux" ON "stores_audit_flag_reviews" USING btree ("flag_id");--> statement-breakpoint
CREATE INDEX "stores_audit_flag_reviews_at_idx" ON "stores_audit_flag_reviews" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_audit_flags_key_ux" ON "stores_audit_flags" USING btree ("key");--> statement-breakpoint
CREATE INDEX "stores_audit_flags_raised_idx" ON "stores_audit_flags" USING btree ("raised_at");--> statement-breakpoint
CREATE TRIGGER stores_audit_flags_append_only BEFORE UPDATE OR DELETE ON stores_audit_flags
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_audit_flag_reviews_append_only BEFORE UPDATE OR DELETE ON stores_audit_flag_reviews
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();
