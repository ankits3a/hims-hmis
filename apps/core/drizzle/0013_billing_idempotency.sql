CREATE TABLE "idempotency_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"route" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'in_progress' NOT NULL,
	"response" jsonb,
	"claimed_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_actor_route_key_ux" ON "idempotency_keys" USING btree ("actor_id","route","key");