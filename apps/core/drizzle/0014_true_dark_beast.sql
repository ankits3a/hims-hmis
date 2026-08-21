CREATE TABLE "event_dead_letters" (
	"consumer" text NOT NULL,
	"seq" bigint NOT NULL,
	"event_id" text NOT NULL,
	"name" text NOT NULL,
	"error" text NOT NULL,
	"attempts" integer NOT NULL,
	"parked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_dead_letters_consumer_seq_pk" PRIMARY KEY("consumer","seq")
);
--> statement-breakpoint
CREATE TABLE "event_deliveries" (
	"consumer" text NOT NULL,
	"seq" bigint NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_deliveries_consumer_seq_pk" PRIMARY KEY("consumer","seq")
);
--> statement-breakpoint
CREATE TABLE "scheduler_heartbeats" (
	"job" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"last_duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"ref_type" text,
	"ref_id" text,
	"source_event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_source_event_user_ux" ON "alerts" USING btree ("source_event_id","user_id");--> statement-breakpoint
CREATE INDEX "alerts_user_read_idx" ON "alerts" USING btree ("user_id","read_at");