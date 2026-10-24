CREATE TABLE "maintenance_ticket_events" (
	"ticket_id" text NOT NULL,
	"seq" integer NOT NULL,
	"act" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "maintenance_ticket_events_ticket_id_seq_pk" PRIMARY KEY("ticket_id","seq"),
	CONSTRAINT "maintenance_ticket_events_act_ck" CHECK ("maintenance_ticket_events"."act" in ('raised', 'reported_again', 'dispatched', 'fixed', 'closed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "maintenance_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"number" serial NOT NULL,
	"place_resource_id" text NOT NULL,
	"item_kind" text NOT NULL,
	"item_tag" text,
	"category" text NOT NULL,
	"urgency" text NOT NULL,
	"description" text NOT NULL,
	"raised_by" text NOT NULL,
	"source" text NOT NULL,
	"bed_block_id" text,
	"task_id" text,
	"state" text DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"fixed_by" text,
	"fixed_at" timestamp with time zone,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"cancel_reason" text,
	"replacement_flag" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "maintenance_tickets_state_ck" CHECK ("maintenance_tickets"."state" in ('open', 'fixed', 'closed', 'cancelled')),
	CONSTRAINT "maintenance_tickets_item_ck" CHECK ("maintenance_tickets"."item_kind" in ('bed', 'oxygen_point', 'suction', 'monitor', 'fixture', 'electrical', 'plumbing', 'ac', 'other')),
	CONSTRAINT "maintenance_tickets_category_ck" CHECK ("maintenance_tickets"."category" in ('general', 'biomedical')),
	CONSTRAINT "maintenance_tickets_urgency_ck" CHECK ("maintenance_tickets"."urgency" in ('routine', 'urgent', 'critical')),
	CONSTRAINT "maintenance_tickets_source_ck" CHECK ("maintenance_tickets"."source" in ('person', 'device', 'block')),
	CONSTRAINT "maintenance_tickets_description_ck" CHECK (char_length("maintenance_tickets"."description") between 1 and 500),
	CONSTRAINT "maintenance_tickets_fixed_ck" CHECK ("maintenance_tickets"."state" not in ('fixed', 'closed') or "maintenance_tickets"."fixed_at" is not null),
	CONSTRAINT "maintenance_tickets_closed_ck" CHECK ("maintenance_tickets"."state" <> 'closed' or ("maintenance_tickets"."closed_at" is not null and "maintenance_tickets"."closed_by" is not null)),
	CONSTRAINT "maintenance_tickets_cancel_ck" CHECK ("maintenance_tickets"."state" <> 'cancelled' or char_length("maintenance_tickets"."cancel_reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "maintenance_ticket_events" ADD CONSTRAINT "maintenance_ticket_events_ticket_id_maintenance_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."maintenance_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_place_resource_id_resources_id_fk" FOREIGN KEY ("place_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_bed_block_id_ipd_bed_blocks_id_fk" FOREIGN KEY ("bed_block_id") REFERENCES "public"."ipd_bed_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_tickets" ADD CONSTRAINT "maintenance_tickets_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_tickets_number_ux" ON "maintenance_tickets" USING btree ("number");--> statement-breakpoint
CREATE INDEX "maintenance_tickets_open_idx" ON "maintenance_tickets" USING btree ("state","due_at") WHERE "maintenance_tickets"."state" in ('open', 'fixed');--> statement-breakpoint
CREATE INDEX "maintenance_tickets_place_idx" ON "maintenance_tickets" USING btree ("place_resource_id","item_kind","created_at");--> statement-breakpoint
CREATE INDEX "maintenance_tickets_tag_idx" ON "maintenance_tickets" USING btree ("item_tag","created_at") WHERE "maintenance_tickets"."item_tag" is not null;--> statement-breakpoint
CREATE INDEX "maintenance_tickets_block_idx" ON "maintenance_tickets" USING btree ("bed_block_id") WHERE "maintenance_tickets"."bed_block_id" is not null;--> statement-breakpoint
CREATE INDEX "maintenance_tickets_task_idx" ON "maintenance_tickets" USING btree ("task_id");--> statement-breakpoint
-- E1.5 MAINTENANCE — a ticket's history is corrected by a further row, never by an edit: no UPDATE, no DELETE.
CREATE OR REPLACE FUNCTION maintenance_ticket_events_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_append_only: maintenance_ticket_events rows are append-only (% refused, ticket %, seq %)', TG_OP, OLD.ticket_id, OLD.seq;
END $$;--> statement-breakpoint
CREATE TRIGGER maintenance_ticket_events_append_only
  BEFORE UPDATE OR DELETE ON "maintenance_ticket_events"
  FOR EACH ROW EXECUTE FUNCTION maintenance_ticket_events_forbid_mutation();
