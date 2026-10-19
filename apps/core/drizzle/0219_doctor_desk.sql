CREATE TABLE "doctor_desk_agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"team_id" text,
	"user_id" text,
	"outcome" text NOT NULL,
	"summary_key" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_desk_agent_runs_outcome_ck" CHECK ("doctor_desk_agent_runs"."outcome" in ('ok', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "doctor_desk_briefs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"facts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"shown_at" timestamp with time zone,
	"seen_at" timestamp with time zone,
	CONSTRAINT "doctor_desk_briefs_kind_ck" CHECK ("doctor_desk_briefs"."kind" in ('login', 'morning', 'round')),
	CONSTRAINT "doctor_desk_briefs_window_ck" CHECK ("doctor_desk_briefs"."window_to" >= "doctor_desk_briefs"."window_from")
);
--> statement-breakpoint
CREATE TABLE "doctor_desk_nudges" (
	"id" text PRIMARY KEY NOT NULL,
	"row_key" text NOT NULL,
	"team_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"holder_id" text NOT NULL,
	"alert_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_desk_nudges_not_self_ck" CHECK ("doctor_desk_nudges"."sender_id" <> "doctor_desk_nudges"."holder_id")
);
--> statement-breakpoint
CREATE TABLE "doctor_desk_reads" (
	"user_id" text PRIMARY KEY NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doctor_desk_briefs" ADD CONSTRAINT "doctor_desk_briefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_desk_nudges" ADD CONSTRAINT "doctor_desk_nudges_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_desk_nudges" ADD CONSTRAINT "doctor_desk_nudges_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_desk_reads" ADD CONSTRAINT "doctor_desk_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doctor_desk_agent_runs_team_idx" ON "doctor_desk_agent_runs" USING btree ("team_id","ran_at");--> statement-breakpoint
CREATE INDEX "doctor_desk_agent_runs_user_idx" ON "doctor_desk_agent_runs" USING btree ("user_id","ran_at");--> statement-breakpoint
CREATE INDEX "doctor_desk_briefs_user_idx" ON "doctor_desk_briefs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_desk_nudges_once_ux" ON "doctor_desk_nudges" USING btree ("row_key","sender_id");--> statement-breakpoint
CREATE INDEX "doctor_desk_nudges_team_idx" ON "doctor_desk_nudges" USING btree ("team_id","created_at");