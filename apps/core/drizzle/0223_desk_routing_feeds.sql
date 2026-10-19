CREATE TABLE "cds_desk_routing_feeds" (
	"id" text PRIMARY KEY NOT NULL,
	"built_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"tail" jsonb NOT NULL,
	"examples" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"floor_score" double precision,
	"baseline_floor_score" double precision,
	"holdout_score" double precision,
	"holdout_visits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cds_desk_routing_feeds_status_ck" CHECK ("cds_desk_routing_feeds"."status" in ('live', 'refused', 'failed', 'empty'))
);
--> statement-breakpoint
CREATE INDEX "cds_desk_routing_feeds_built_idx" ON "cds_desk_routing_feeds" USING btree ("built_at");