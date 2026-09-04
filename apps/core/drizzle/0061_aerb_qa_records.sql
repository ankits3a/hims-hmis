-- PLAN 18c T2 — THE QUALITY-ASSURANCE REGISTER, and the writer `qa_blocked` has been waiting for.
--
-- 18a declared `qa_blocked` in the `device` kind's vocabulary, honoured it in the scheduler and at
-- acquisition, and left NOTHING in the tree able to set it — in its own words, *"the workflow that
-- puts a device INTO it is 18c's"*. `recordQa` is that writer, and it moves the machine through the
-- resource registry inside the transaction that records the failure.
--
-- Two CHECKs carry the design. `aerb_qa_records_release_ck`: a record cannot claim it released a
-- machine without saying when, or the reverse — half a fact is not a record. `aerb_qa_records_block_ck`:
-- only a non-passing result can have applied a block, so a `pass` row claiming one is a lie about
-- the machine that the database refuses to store.
--
-- `values` is jsonb because the measured quantities differ per protocol (kVp accuracy, HVL, output
-- repeatability, AEC consistency, a mammography phantom score) and a column per quantity would be a
-- migration every time the agency changed its form. What is NOT in jsonb is the thing the system
-- acts on: `result`.
--
-- This migration was generated clean — 0060's snapshot repaired the baseline that made it itself
-- sweep up two other lanes' hand-written deltas (see that file's header).

CREATE TABLE "aerb_qa_records" (
	"id" text PRIMARY KEY NOT NULL,
	"device_resource_id" text NOT NULL,
	"qa_type" text NOT NULL,
	"result" text NOT NULL,
	"performed_by" text NOT NULL,
	"performed_on" date NOT NULL,
	"agency_ref" text,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_due_on" date,
	"block_applied" boolean DEFAULT false NOT NULL,
	"released_by_record_id" text,
	"released_at" timestamp with time zone,
	"remarks" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aerb_qa_records_result_ck" CHECK ("aerb_qa_records"."result" in ('pass', 'fail', 'conditional')),
	CONSTRAINT "aerb_qa_records_release_ck" CHECK (("aerb_qa_records"."released_by_record_id" is null) = ("aerb_qa_records"."released_at" is null)),
	CONSTRAINT "aerb_qa_records_block_ck" CHECK ("aerb_qa_records"."block_applied" = false or "aerb_qa_records"."result" <> 'pass')
);
--> statement-breakpoint
ALTER TABLE "aerb_qa_records" ADD CONSTRAINT "aerb_qa_records_device_resource_id_resources_id_fk" FOREIGN KEY ("device_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aerb_qa_records_device_idx" ON "aerb_qa_records" USING btree ("device_resource_id","performed_on");--> statement-breakpoint
CREATE INDEX "aerb_qa_records_due_idx" ON "aerb_qa_records" USING btree ("next_due_on");