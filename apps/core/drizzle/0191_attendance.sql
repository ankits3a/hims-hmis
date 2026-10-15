CREATE TABLE "att_days" (
	"pin" text NOT NULL,
	"date" date NOT NULL,
	"first_in" text,
	"last_out" text,
	"hours_worked" double precision,
	"ot_minutes" integer,
	"shift_name" text,
	"status" text NOT NULL,
	"day_type" text,
	"locked" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "att_days_pin_date_pk" PRIMARY KEY("pin","date")
);
--> statement-breakpoint
CREATE TABLE "att_holidays" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "att_holidays_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"date" date NOT NULL,
	"name" text NOT NULL,
	"dept" text,
	"cancelled" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "att_leaves" (
	"pin" text NOT NULL,
	"date" date NOT NULL,
	"reason" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "att_leaves_pin_date_pk" PRIMARY KEY("pin","date")
);
--> statement-breakpoint
CREATE TABLE "att_meeting_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"pin" text NOT NULL,
	"date" date NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_by" text,
	"seen_at" timestamp with time zone,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"close_note" text,
	CONSTRAINT "att_meeting_requests_status_chk" CHECK ("att_meeting_requests"."status" in ('open', 'seen', 'closed', 'resolved_by_correction')),
	CONSTRAINT "att_meeting_requests_note_chk" CHECK (("att_meeting_requests"."note" is null or char_length("att_meeting_requests"."note") <= 200) and ("att_meeting_requests"."close_note" is null or char_length("att_meeting_requests"."close_note") <= 200))
);
--> statement-breakpoint
CREATE TABLE "att_on_duty" (
	"pin" text PRIMARY KEY NOT NULL,
	"in_since" text,
	"device" text,
	"as_of" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "att_punches" (
	"id" bigint PRIMARY KEY NOT NULL,
	"pin" text NOT NULL,
	"ts" text NOT NULL,
	"day" date NOT NULL,
	"direction" text,
	"verify" text,
	"device" text,
	"origin" text,
	"received_via" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "att_punches_via_chk" CHECK ("att_punches"."received_via" in ('pull', 'webhook'))
);
--> statement-breakpoint
CREATE TABLE "att_roster" (
	"pin" text NOT NULL,
	"date" date NOT NULL,
	"shift_name" text,
	"start_time" text,
	"end_time" text,
	"off" boolean DEFAULT false NOT NULL,
	"holiday" text,
	"leave" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "att_roster_pin_date_pk" PRIMARY KEY("pin","date")
);
--> statement-breakpoint
CREATE TABLE "att_shifts" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"dept" text,
	"checkin_time" text,
	"checkout_time" text,
	"crosses_midnight" boolean DEFAULT false NOT NULL,
	"grace_minutes" integer,
	"kind" text,
	"weekly_off_days" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "att_staff" (
	"pin" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"dept" text,
	"post" text,
	"gender" text,
	"mobile" text,
	"status" text NOT NULL,
	"joining_date" date,
	"date_of_leaving" date,
	"work_days" text,
	"aadhaar_hash" text,
	"user_id" text,
	"link_source" text,
	"linked_at" timestamp with time zone,
	"needs_attention" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "att_staff_link_source_chk" CHECK ("att_staff"."link_source" is null or "att_staff"."link_source" in ('mobile', 'aadhaar')),
	CONSTRAINT "att_staff_link_pair_chk" CHECK (("att_staff"."user_id" is null) = ("att_staff"."link_source" is null))
);
--> statement-breakpoint
CREATE TABLE "att_sync_state" (
	"stage" text PRIMARY KEY NOT NULL,
	"cursor" bigint,
	"last_attempt_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_outcome" text,
	"last_error" text,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "aadhaar_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "aadhaar_last4" text;--> statement-breakpoint
ALTER TABLE "att_meeting_requests" ADD CONSTRAINT "att_meeting_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "att_meeting_requests" ADD CONSTRAINT "att_meeting_requests_seen_by_users_id_fk" FOREIGN KEY ("seen_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "att_meeting_requests" ADD CONSTRAINT "att_meeting_requests_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "att_staff" ADD CONSTRAINT "att_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "att_days_date_idx" ON "att_days" USING btree ("date");--> statement-breakpoint
CREATE INDEX "att_holidays_date_idx" ON "att_holidays" USING btree ("date");--> statement-breakpoint
CREATE INDEX "att_leaves_date_idx" ON "att_leaves" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "att_meeting_requests_active_ux" ON "att_meeting_requests" USING btree ("user_id","date") WHERE "att_meeting_requests"."status" in ('open', 'seen');--> statement-breakpoint
CREATE INDEX "att_meeting_requests_status_idx" ON "att_meeting_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "att_meeting_requests_pin_date_idx" ON "att_meeting_requests" USING btree ("pin","date");--> statement-breakpoint
CREATE INDEX "att_punches_pin_day_idx" ON "att_punches" USING btree ("pin","day");--> statement-breakpoint
CREATE INDEX "att_roster_date_idx" ON "att_roster" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "att_staff_user_ux" ON "att_staff" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "att_staff_aadhaar_idx" ON "att_staff" USING btree ("aadhaar_hash");