CREATE TABLE "events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"patient_id" text,
	"encounter_id" text,
	"correlation_id" text,
	"causation_id" text,
	"module" text NOT NULL,
	"payload" jsonb NOT NULL,
	"site_id" text DEFAULT 'main' NOT NULL,
	"idempotency_key" text,
	CONSTRAINT "events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "events_idempotency_key_ux" ON "events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "events_name_idx" ON "events" USING btree ("name");--> statement-breakpoint
CREATE INDEX "events_patient_idx" ON "events" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "events_correlation_idx" ON "events" USING btree ("correlation_id");