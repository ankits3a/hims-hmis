ALTER TABLE "tasks" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "raised_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_source_ref_ux" ON "tasks" USING btree ("source_ref") WHERE "tasks"."source_ref" is not null;