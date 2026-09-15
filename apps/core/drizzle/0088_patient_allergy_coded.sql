ALTER TABLE "patient_allergies" ADD COLUMN "salt_id" text;--> statement-breakpoint
ALTER TABLE "patient_allergies" ADD COLUMN "allergen_class" text;--> statement-breakpoint
CREATE INDEX "patient_allergies_class_idx" ON "patient_allergies" USING btree ("allergen_class");