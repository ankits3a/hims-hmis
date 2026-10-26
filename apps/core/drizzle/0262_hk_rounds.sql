-- HK-1 housekeeping (#973, decision 0086): areas and door QR, checklists, contractors and staff, shift rota, rounds, work proof, door requests; the task history gains the act `rejected` (a failed check). Additive.
CREATE TABLE "hk_areas" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"area_class" text NOT NULL,
	"floor_id" text,
	"checklist_id" text,
	"photo_needed" boolean DEFAULT false NOT NULL,
	"qr_version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hk_areas_class_ck" CHECK ("hk_areas"."area_class" in ('A', 'B', 'C_toilet', 'C_public', 'D')),
	CONSTRAINT "hk_areas_qr_version_ck" CHECK ("hk_areas"."qr_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "hk_checklists" (
	"id" text PRIMARY KEY NOT NULL,
	"lineage_id" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"items" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hk_checklists_version_ck" CHECK ("hk_checklists"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "hk_contractors" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hk_door_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"area_id" text NOT NULL,
	"need" text NOT NULL,
	"task_id" text NOT NULL,
	"address_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hk_door_requests_need_ck" CHECK ("hk_door_requests"."need" in ('clean', 'toilet', 'spill', 'bin'))
);
--> statement-breakpoint
CREATE TABLE "hk_rota_places" (
	"rota_id" text NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"floor_id" text,
	"area_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"bed_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"floor_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "hk_rota_places_rota_id_user_id_pk" PRIMARY KEY("rota_id","user_id"),
	CONSTRAINT "hk_rota_places_mode_ck" CHECK ("hk_rota_places"."mode" in ('floor', 'route', 'beds')),
	CONSTRAINT "hk_rota_places_shape_ck" CHECK (("hk_rota_places"."mode" = 'floor') = ("hk_rota_places"."floor_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "hk_rotas" (
	"id" text PRIMARY KEY NOT NULL,
	"shift_starts_at" timestamp with time zone NOT NULL,
	"shift_ends_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone,
	CONSTRAINT "hk_rotas_status_ck" CHECK ("hk_rotas"."status" in ('draft', 'published', 'superseded')),
	CONSTRAINT "hk_rotas_window_ck" CHECK ("hk_rotas"."shift_ends_at" > "hk_rotas"."shift_starts_at"),
	CONSTRAINT "hk_rotas_published_ck" CHECK ("hk_rotas"."status" = 'draft' or "hk_rotas"."published_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "hk_rounds" (
	"id" text PRIMARY KEY NOT NULL,
	"area_id" text NOT NULL,
	"slot_start" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"task_id" text NOT NULL,
	"status" text DEFAULT 'due' NOT NULL,
	"missed_at" timestamp with time zone,
	CONSTRAINT "hk_rounds_status_ck" CHECK ("hk_rounds"."status" in ('due', 'done', 'missed')),
	CONSTRAINT "hk_rounds_missed_ck" CHECK ("hk_rounds"."status" = 'done' or (("hk_rounds"."status" = 'missed') = ("hk_rounds"."missed_at" is not null)))
);
--> statement-breakpoint
CREATE TABLE "hk_staff" (
	"user_id" text PRIMARY KEY NOT NULL,
	"contractor_id" text,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hk_staff_skills_ck" CHECK ("hk_staff"."skills" <@ array['critical', 'spill', 'terminal']::text[])
);
--> statement-breakpoint
CREATE TABLE "hk_work" (
	"task_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"done_by" text NOT NULL,
	"company" text NOT NULL,
	"contractor_id" text,
	"scan_area_id" text NOT NULL,
	"qr_version" integer NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL,
	"checklist_id" text,
	"answers" jsonb NOT NULL,
	"photo_key" text,
	CONSTRAINT "hk_work_task_id_attempt_pk" PRIMARY KEY("task_id","attempt"),
	CONSTRAINT "hk_work_attempt_ck" CHECK ("hk_work"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "task_events" DROP CONSTRAINT "task_events_act_ck";--> statement-breakpoint
ALTER TABLE "hk_areas" ADD CONSTRAINT "hk_areas_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_areas" ADD CONSTRAINT "hk_areas_floor_id_resources_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_areas" ADD CONSTRAINT "hk_areas_checklist_id_hk_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."hk_checklists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_door_requests" ADD CONSTRAINT "hk_door_requests_area_id_hk_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."hk_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_door_requests" ADD CONSTRAINT "hk_door_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_rota_places" ADD CONSTRAINT "hk_rota_places_rota_id_hk_rotas_id_fk" FOREIGN KEY ("rota_id") REFERENCES "public"."hk_rotas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_rota_places" ADD CONSTRAINT "hk_rota_places_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_rota_places" ADD CONSTRAINT "hk_rota_places_floor_id_resources_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_rounds" ADD CONSTRAINT "hk_rounds_area_id_hk_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."hk_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_rounds" ADD CONSTRAINT "hk_rounds_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_staff" ADD CONSTRAINT "hk_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_staff" ADD CONSTRAINT "hk_staff_contractor_id_hk_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."hk_contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_work" ADD CONSTRAINT "hk_work_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_work" ADD CONSTRAINT "hk_work_contractor_id_hk_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."hk_contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_work" ADD CONSTRAINT "hk_work_scan_area_id_hk_areas_id_fk" FOREIGN KEY ("scan_area_id") REFERENCES "public"."hk_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hk_work" ADD CONSTRAINT "hk_work_checklist_id_hk_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."hk_checklists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hk_areas_resource_ux" ON "hk_areas" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "hk_areas_floor_idx" ON "hk_areas" USING btree ("floor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hk_checklists_lineage_version_ux" ON "hk_checklists" USING btree ("lineage_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "hk_contractors_name_ux" ON "hk_contractors" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "hk_door_requests_area_idx" ON "hk_door_requests" USING btree ("area_id","created_at");--> statement-breakpoint
CREATE INDEX "hk_rotas_shift_idx" ON "hk_rotas" USING btree ("shift_starts_at","status");--> statement-breakpoint
CREATE UNIQUE INDEX "hk_rounds_area_slot_ux" ON "hk_rounds" USING btree ("area_id","slot_start");--> statement-breakpoint
CREATE UNIQUE INDEX "hk_rounds_task_ux" ON "hk_rounds" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "hk_rounds_due_idx" ON "hk_rounds" USING btree ("due_at") WHERE "hk_rounds"."status" = 'due';--> statement-breakpoint
CREATE INDEX "hk_rounds_missed_idx" ON "hk_rounds" USING btree ("missed_at") WHERE "hk_rounds"."status" = 'missed';--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_act_ck" CHECK ("task_events"."act" in ('raised', 'merged', 'assigned', 'redispatched', 'accepted', 'started', 'done', 'verified', 'cancelled', 'returned', 'escalated', 'rejected'));