CREATE TABLE "event_idempotency" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"seq" bigint,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "events_idempotency_key_ux";--> statement-breakpoint
CREATE INDEX "events_idempotency_key_idx" ON "events" USING btree ("idempotency_key");