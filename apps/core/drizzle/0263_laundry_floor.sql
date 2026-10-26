-- LD-1 laundry floor (#978, decision 0087): item streams, rounds signed by runner and ward, sealed bags, holds, machines and wash cycles (a cycle and its batches agree on infected and stream by key), quality check, beds waiting for linen, and piece identity; new ledger kinds. Additive.
CREATE TABLE "linen_bags" (
	"id" text PRIMARY KEY NOT NULL,
	"tag" text NOT NULL,
	"ward_resource_id" text NOT NULL,
	"bed_resource_id" text,
	"infected" boolean NOT NULL,
	"lines" jsonb NOT NULL,
	"state" text DEFAULT 'sealed' NOT NULL,
	"weight_grams" integer,
	"sealed_by" text NOT NULL,
	"sealed_at" timestamp with time zone NOT NULL,
	"round_id" text,
	"batch_id" text,
	CONSTRAINT "linen_bags_state_ck" CHECK ("linen_bags"."state" in ('sealed', 'picked', 'sent', 'handed_over')),
	CONSTRAINT "linen_bags_weight_ck" CHECK ("linen_bags"."weight_grams" is null or "linen_bags"."weight_grams" > 0),
	CONSTRAINT "linen_bags_picked_ck" CHECK ("linen_bags"."state" = 'handed_over' or (("linen_bags"."state" = 'sealed') = ("linen_bags"."round_id" is null))),
	CONSTRAINT "linen_bags_sent_ck" CHECK (("linen_bags"."state" = 'sent') = ("linen_bags"."batch_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "linen_bed_waits" (
	"id" text PRIMARY KEY NOT NULL,
	"bed_resource_id" text NOT NULL,
	"ward_resource_id" text NOT NULL,
	"short" jsonb NOT NULL,
	"rush" boolean DEFAULT true NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"raised_by" text NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" text,
	CONSTRAINT "linen_bed_waits_cleared_ck" CHECK (("linen_bed_waits"."cleared_at" is null) = ("linen_bed_waits"."cleared_by" is null))
);
--> statement-breakpoint
CREATE TABLE "linen_cycle_batches" (
	"cycle_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"infected" boolean NOT NULL,
	"stream" text NOT NULL,
	CONSTRAINT "linen_cycle_batches_cycle_id_batch_id_pk" PRIMARY KEY("cycle_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "linen_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"bed_resource_id" text NOT NULL,
	"ward_resource_id" text NOT NULL,
	"note" text,
	"release_after" timestamp with time zone,
	"state" text DEFAULT 'active' NOT NULL,
	"placed_by" text NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"released_by" text,
	"released_at" timestamp with time zone,
	"police_name" text,
	"police_rank" text,
	"police_station" text,
	CONSTRAINT "linen_holds_kind_ck" CHECK ("linen_holds"."kind" in ('mlc', 'chemo', 'radioactive')),
	CONSTRAINT "linen_holds_state_ck" CHECK ("linen_holds"."state" in ('active', 'released', 'handed_over')),
	CONSTRAINT "linen_holds_released_ck" CHECK (("linen_holds"."state" = 'active') = ("linen_holds"."released_at" is null)),
	CONSTRAINT "linen_holds_mlc_ck" CHECK (("linen_holds"."state" = 'handed_over') = ("linen_holds"."kind" = 'mlc' and "linen_holds"."state" <> 'active')),
	CONSTRAINT "linen_holds_police_ck" CHECK (("linen_holds"."state" = 'handed_over') = ("linen_holds"."police_name" is not null and "linen_holds"."police_rank" is not null and "linen_holds"."police_station" is not null)),
	CONSTRAINT "linen_holds_chemo_ck" CHECK (("linen_holds"."kind" = 'chemo') = ("linen_holds"."release_after" is not null))
);
--> statement-breakpoint
CREATE TABLE "linen_machines" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"state" text DEFAULT 'up' NOT NULL,
	"down_reason" text,
	"ticket_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "linen_machines_kind_ck" CHECK ("linen_machines"."kind" in ('washer', 'dryer', 'calender', 'boiler')),
	CONSTRAINT "linen_machines_state_ck" CHECK ("linen_machines"."state" in ('up', 'down')),
	CONSTRAINT "linen_machines_down_ck" CHECK (("linen_machines"."state" = 'down') = ("linen_machines"."down_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "linen_pieces" (
	"id" text PRIMARY KEY NOT NULL,
	"item_code" text NOT NULL,
	"tag_uid" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linen_qc_results" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"item_code" text NOT NULL,
	"pass" integer NOT NULL,
	"rewash" integer NOT NULL,
	"mend" integer NOT NULL,
	"condemn" integer NOT NULL,
	"condemn_request_id" text,
	"checked_by" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "linen_qc_results_counts_ck" CHECK ("linen_qc_results"."pass" >= 0 and "linen_qc_results"."rewash" >= 0 and "linen_qc_results"."mend" >= 0 and "linen_qc_results"."condemn" >= 0),
	CONSTRAINT "linen_qc_results_condemn_ck" CHECK (("linen_qc_results"."condemn" > 0) = ("linen_qc_results"."condemn_request_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "linen_rounds" (
	"id" text PRIMARY KEY NOT NULL,
	"ward_resource_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"slot_at" timestamp with time zone,
	"task_id" text,
	"runner_id" text,
	"ward_signed_by" text,
	"runner_only_reason" text,
	"pieces" integer DEFAULT 0 NOT NULL,
	"bags" integer DEFAULT 0 NOT NULL,
	"signed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "linen_rounds_kind_ck" CHECK ("linen_rounds"."kind" in ('pickup', 'delivery')),
	CONSTRAINT "linen_rounds_state_ck" CHECK ("linen_rounds"."state" in ('open', 'signed', 'skipped')),
	CONSTRAINT "linen_rounds_signed_ck" CHECK (("linen_rounds"."state" = 'signed') = ("linen_rounds"."signed_at" is not null and "linen_rounds"."runner_id" is not null)),
	CONSTRAINT "linen_rounds_one_ward_sign_ck" CHECK ("linen_rounds"."state" <> 'signed' or (("linen_rounds"."ward_signed_by" is null) <> ("linen_rounds"."runner_only_reason" is null))),
	CONSTRAINT "linen_rounds_not_self_ck" CHECK ("linen_rounds"."ward_signed_by" is null or "linen_rounds"."ward_signed_by" <> "linen_rounds"."runner_id"),
	CONSTRAINT "linen_rounds_counts_ck" CHECK ("linen_rounds"."pieces" >= 0 and "linen_rounds"."bags" >= 0)
);
--> statement-breakpoint
CREATE TABLE "linen_wash_cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"program" text NOT NULL,
	"infected" boolean NOT NULL,
	"stream" text NOT NULL,
	"started_by" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_by" text,
	"finished_at" timestamp with time zone,
	"temp_c" integer,
	"hold_min" integer,
	"chemical" text,
	"disinfected" boolean,
	CONSTRAINT "linen_wash_cycles_key_uq" UNIQUE("id","infected","stream"),
	CONSTRAINT "linen_wash_cycles_stream_ck" CHECK ("linen_wash_cycles"."stream" in ('ward', 'theatre', 'baby', 'mop', 'kitchen', 'uniform')),
	CONSTRAINT "linen_wash_cycles_finished_ck" CHECK (("linen_wash_cycles"."finished_at" is null) = ("linen_wash_cycles"."temp_c" is null) and ("linen_wash_cycles"."finished_at" is null) = ("linen_wash_cycles"."hold_min" is null)),
	CONSTRAINT "linen_wash_cycles_reading_ck" CHECK ("linen_wash_cycles"."temp_c" is null or ("linen_wash_cycles"."temp_c" between 0 and 120 and "linen_wash_cycles"."hold_min" between 0 and 180))
);
--> statement-breakpoint
ALTER TABLE "linen_laundry_batches" DROP CONSTRAINT "linen_laundry_batches_state_ck";--> statement-breakpoint
ALTER TABLE "linen_laundry_batches" DROP CONSTRAINT "linen_laundry_batches_received_ck";--> statement-breakpoint
ALTER TABLE "linen_movements" DROP CONSTRAINT "linen_movements_kind_ck";--> statement-breakpoint
ALTER TABLE "linen_movements" DROP CONSTRAINT "linen_movements_ward_ck";--> statement-breakpoint
ALTER TABLE "linen_movements" DROP CONSTRAINT "linen_movements_batch_ck";--> statement-breakpoint
ALTER TABLE "linen_items" ADD COLUMN "stream" text DEFAULT 'ward' NOT NULL;--> statement-breakpoint
ALTER TABLE "linen_laundry_batches" ADD COLUMN "stream" text DEFAULT 'ward' NOT NULL;--> statement-breakpoint
ALTER TABLE "linen_laundry_batches" ADD COLUMN "mode" text DEFAULT 'vendor' NOT NULL;--> statement-breakpoint
ALTER TABLE "linen_movements" ADD COLUMN "round_id" text;--> statement-breakpoint
ALTER TABLE "linen_movements" ADD COLUMN "bag_id" text;--> statement-breakpoint
ALTER TABLE "linen_movements" ADD COLUMN "piece_id" text;--> statement-breakpoint
ALTER TABLE "linen_laundry_batches" ADD CONSTRAINT "linen_laundry_batches_cycle_key_uq" UNIQUE("id","infected","stream");--> statement-breakpoint
ALTER TABLE "linen_bags" ADD CONSTRAINT "linen_bags_ward_resource_id_resources_id_fk" FOREIGN KEY ("ward_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_bags" ADD CONSTRAINT "linen_bags_bed_resource_id_resources_id_fk" FOREIGN KEY ("bed_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_bags" ADD CONSTRAINT "linen_bags_round_id_linen_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."linen_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_bags" ADD CONSTRAINT "linen_bags_batch_id_linen_laundry_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."linen_laundry_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_bed_waits" ADD CONSTRAINT "linen_bed_waits_bed_resource_id_resources_id_fk" FOREIGN KEY ("bed_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_bed_waits" ADD CONSTRAINT "linen_bed_waits_ward_resource_id_resources_id_fk" FOREIGN KEY ("ward_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_cycle_batches" ADD CONSTRAINT "linen_cycle_batches_cycle_fk" FOREIGN KEY ("cycle_id","infected","stream") REFERENCES "public"."linen_wash_cycles"("id","infected","stream") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_cycle_batches" ADD CONSTRAINT "linen_cycle_batches_batch_fk" FOREIGN KEY ("batch_id","infected","stream") REFERENCES "public"."linen_laundry_batches"("id","infected","stream") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_holds" ADD CONSTRAINT "linen_holds_bed_resource_id_resources_id_fk" FOREIGN KEY ("bed_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_holds" ADD CONSTRAINT "linen_holds_ward_resource_id_resources_id_fk" FOREIGN KEY ("ward_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_pieces" ADD CONSTRAINT "linen_pieces_item_code_linen_items_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."linen_items"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_qc_results" ADD CONSTRAINT "linen_qc_results_batch_id_linen_laundry_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."linen_laundry_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_qc_results" ADD CONSTRAINT "linen_qc_results_item_code_linen_items_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."linen_items"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_qc_results" ADD CONSTRAINT "linen_qc_results_condemn_request_id_linen_condemn_requests_id_fk" FOREIGN KEY ("condemn_request_id") REFERENCES "public"."linen_condemn_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_rounds" ADD CONSTRAINT "linen_rounds_ward_resource_id_resources_id_fk" FOREIGN KEY ("ward_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_wash_cycles" ADD CONSTRAINT "linen_wash_cycles_machine_id_linen_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."linen_machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linen_bags_live_tag_uq" ON "linen_bags" USING btree ("tag") WHERE "linen_bags"."state" in ('sealed', 'picked');--> statement-breakpoint
CREATE INDEX "linen_bags_bed_idx" ON "linen_bags" USING btree ("bed_resource_id") WHERE "linen_bags"."bed_resource_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "linen_bed_waits_open_uq" ON "linen_bed_waits" USING btree ("bed_resource_id") WHERE "linen_bed_waits"."cleared_at" is null;--> statement-breakpoint
CREATE INDEX "linen_bed_waits_ward_idx" ON "linen_bed_waits" USING btree ("ward_resource_id") WHERE "linen_bed_waits"."cleared_at" is null;--> statement-breakpoint
CREATE INDEX "linen_cycle_batches_batch_idx" ON "linen_cycle_batches" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "linen_holds_active_idx" ON "linen_holds" USING btree ("bed_resource_id") WHERE "linen_holds"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "linen_machines_code_uq" ON "linen_machines" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "linen_pieces_tag_uq" ON "linen_pieces" USING btree ("tag_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "linen_qc_results_batch_item_uq" ON "linen_qc_results" USING btree ("batch_id","item_code");--> statement-breakpoint
CREATE UNIQUE INDEX "linen_rounds_slot_uq" ON "linen_rounds" USING btree ("ward_resource_id","kind","slot_at") WHERE "linen_rounds"."slot_at" is not null;--> statement-breakpoint
CREATE INDEX "linen_rounds_open_idx" ON "linen_rounds" USING btree ("state") WHERE "linen_rounds"."state" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "linen_wash_cycles_running_uq" ON "linen_wash_cycles" USING btree ("machine_id") WHERE "linen_wash_cycles"."finished_at" is null;--> statement-breakpoint
ALTER TABLE "linen_movements" ADD CONSTRAINT "linen_movements_round_id_linen_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."linen_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_movements" ADD CONSTRAINT "linen_movements_bag_id_linen_bags_id_fk" FOREIGN KEY ("bag_id") REFERENCES "public"."linen_bags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_movements" ADD CONSTRAINT "linen_movements_piece_id_linen_pieces_id_fk" FOREIGN KEY ("piece_id") REFERENCES "public"."linen_pieces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linen_items" ADD CONSTRAINT "linen_items_stream_ck" CHECK ("linen_items"."stream" in ('ward', 'theatre', 'baby', 'mop', 'kitchen', 'uniform'));--> statement-breakpoint
ALTER TABLE "linen_laundry_batches" ADD CONSTRAINT "linen_laundry_batches_stream_ck" CHECK ("linen_laundry_batches"."stream" in ('ward', 'theatre', 'baby', 'mop', 'kitchen', 'uniform'));--> statement-breakpoint
ALTER TABLE "linen_laundry_batches" ADD CONSTRAINT "linen_laundry_batches_mode_ck" CHECK ("linen_laundry_batches"."mode" in ('in_house', 'vendor'));--> statement-breakpoint
ALTER TABLE "linen_laundry_batches" ADD CONSTRAINT "linen_laundry_batches_plant_ck" CHECK ("linen_laundry_batches"."mode" = 'in_house' or "linen_laundry_batches"."state" in ('sent', 'received', 'short'));--> statement-breakpoint
ALTER TABLE "linen_laundry_batches" ADD CONSTRAINT "linen_laundry_batches_state_ck" CHECK ("linen_laundry_batches"."state" in ('sent', 'washing', 'rewash', 'qc', 'received', 'short'));--> statement-breakpoint
ALTER TABLE "linen_laundry_batches" ADD CONSTRAINT "linen_laundry_batches_received_ck" CHECK (("linen_laundry_batches"."state" in ('sent', 'washing', 'rewash', 'qc')) = ("linen_laundry_batches"."received_at" is null));--> statement-breakpoint
ALTER TABLE "linen_movements" ADD CONSTRAINT "linen_movements_piece_ck" CHECK ("linen_movements"."piece_id" is null or "linen_movements"."qty" = 1);--> statement-breakpoint
ALTER TABLE "linen_movements" ADD CONSTRAINT "linen_movements_kind_ck" CHECK ("linen_movements"."kind" in ('issue_to_ward', 'return_soiled', 'return_infected', 'laundry_out', 'laundry_in', 'condemn', 'transfer_between_wards', 'qc_rewash', 'qc_mend', 'mend_return', 'issue_to_cssd', 'hold_handed_over'));--> statement-breakpoint
ALTER TABLE "linen_movements" ADD CONSTRAINT "linen_movements_ward_ck" CHECK (("linen_movements"."kind" in ('issue_to_ward', 'return_soiled', 'return_infected', 'transfer_between_wards', 'hold_handed_over')) <= ("linen_movements"."ward_resource_id" is not null));--> statement-breakpoint
ALTER TABLE "linen_movements" ADD CONSTRAINT "linen_movements_batch_ck" CHECK (("linen_movements"."kind" in ('laundry_out', 'laundry_in', 'qc_rewash', 'qc_mend', 'issue_to_cssd')) = ("linen_movements"."batch_id" is not null));--> statement-breakpoint
-- Theatre linen washes in its own stream and goes to CSSD; baby linen gets its own item and stream (DECIDED).
UPDATE "linen_items" SET "stream" = 'theatre' WHERE "code" in ('ot_gown', 'ot_drape');--> statement-breakpoint
INSERT INTO "linen_items" ("code", "name", "units_per_set", "sort", "stream") VALUES ('baby_wrap', 'Baby wrap', 0, 9, 'baby') ON CONFLICT ("code") DO NOTHING;
