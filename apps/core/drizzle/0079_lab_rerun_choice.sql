ALTER TABLE "lab_results" ADD COLUMN "reported_choice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "reported_choice_by" text;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "reported_choice_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "lab_results_one_choice_idx" ON "lab_results" USING btree ("order_item_id","analyte_id") WHERE "lab_results"."reported_choice_at" is not null;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_reported_choice_ck" CHECK (("lab_results"."reported_choice_at" is null) = ("lab_results"."reported_choice_by" is null)
        and ("lab_results"."reported_choice_at" is null) = ("lab_results"."reported_choice_reason" is null));--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_reported_choice_reason_ck" CHECK ("lab_results"."reported_choice_reason" is null or length(btrim("lab_results"."reported_choice_reason")) > 0);