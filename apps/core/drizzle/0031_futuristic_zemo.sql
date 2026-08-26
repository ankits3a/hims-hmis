CREATE TABLE "resource_status_history" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"occupant_type" text,
	"occupant_ref" text,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"parent_id" text,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"occupant_type" text,
	"occupant_ref" text,
	"since" timestamp with time zone,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_kind_ck" CHECK ("resources"."kind" in ('floor', 'ward', 'hall', 'room', 'bed', 'theatre', 'store', 'bench', 'analyzer', 'device'))
);
--> statement-breakpoint
ALTER TABLE "resource_status_history" ADD CONSTRAINT "resource_status_history_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_parent_id_resources_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_status_history_resource_seq_idx" ON "resource_status_history" USING btree ("resource_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "resources_site_kind_code_lower_ux" ON "resources" USING btree ("site_id","kind",lower("code"));--> statement-breakpoint
CREATE INDEX "resources_parent_idx" ON "resources" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "resources_kind_status_idx" ON "resources" USING btree ("kind","status");