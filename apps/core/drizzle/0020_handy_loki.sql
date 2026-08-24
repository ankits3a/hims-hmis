CREATE TABLE "search_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"actor_id" text NOT NULL,
	"raw_query" text NOT NULL,
	"query_hash" text NOT NULL,
	"entity_counts" jsonb NOT NULL,
	"total_hits" integer NOT NULL,
	"took_ms" integer NOT NULL,
	"source" text DEFAULT 'text' NOT NULL,
	"restricted_surfaced" boolean DEFAULT false NOT NULL,
	"opened_entity" text,
	"opened_id" text,
	"opened_at" timestamp with time zone,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "search_audit_actor_at_idx" ON "search_audit" USING btree ("actor_id","at");--> statement-breakpoint
CREATE INDEX "search_audit_at_idx" ON "search_audit" USING btree ("at");