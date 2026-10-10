CREATE TABLE "att_app_marks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"pin" text NOT NULL,
	"day" date NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"place" text NOT NULL,
	"distance_m" integer,
	CONSTRAINT "att_app_marks_kind_chk" CHECK ("att_app_marks"."kind" in ('in', 'out')),
	CONSTRAINT "att_app_marks_place_chk" CHECK ("att_app_marks"."place" in ('inside', 'outside', 'not_shared', 'doubtful')),
	CONSTRAINT "att_app_marks_distance_chk" CHECK (("att_app_marks"."place" = 'not_shared') = ("att_app_marks"."distance_m" is null) and ("att_app_marks"."distance_m" is null or "att_app_marks"."distance_m" >= 0))
);
--> statement-breakpoint
ALTER TABLE "att_app_marks" ADD CONSTRAINT "att_app_marks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "att_app_marks_pin_day_idx" ON "att_app_marks" USING btree ("pin","day");--> statement-breakpoint
CREATE INDEX "att_app_marks_user_day_idx" ON "att_app_marks" USING btree ("user_id","day");