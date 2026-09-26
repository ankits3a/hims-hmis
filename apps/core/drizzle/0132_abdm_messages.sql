CREATE TABLE "abdm_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"request_id" text NOT NULL,
	"correlation_request_id" text,
	"http_status" integer,
	"headers" jsonb NOT NULL,
	"body" jsonb,
	"response_body" jsonb,
	"error" text,
	"dispatch" text,
	"patient_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "abdm_messages_direction_ck" CHECK ("abdm_messages"."direction" in ('out', 'in')),
	CONSTRAINT "abdm_messages_dispatch_ck" CHECK ("abdm_messages"."dispatch" is null or "abdm_messages"."dispatch" in ('pending', 'handled', 'unhandled', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "abdm_messages" ADD CONSTRAINT "abdm_messages_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "abdm_messages_in_request_ux" ON "abdm_messages" USING btree ("request_id") WHERE "abdm_messages"."direction" = 'in';--> statement-breakpoint
CREATE INDEX "abdm_messages_correlation_idx" ON "abdm_messages" USING btree ("correlation_request_id");--> statement-breakpoint
CREATE INDEX "abdm_messages_kind_created_idx" ON "abdm_messages" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "abdm_messages_patient_idx" ON "abdm_messages" USING btree ("patient_id");