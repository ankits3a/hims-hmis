CREATE TABLE "doctor_desk_acts" (
	"id" text PRIMARY KEY NOT NULL,
	"row_key" text NOT NULL,
	"team_id" text,
	"holder_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"choice" text NOT NULL,
	"note" text,
	"opened_at" timestamp with time zone NOT NULL,
	"acted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_desk_acts_choice_ck" CHECK ("doctor_desk_acts"."choice" in ('seen_at_bedside', 'ecg_ordered', 'repeat_sample_sent', 'treatment_started', 'other')),
	CONSTRAINT "doctor_desk_acts_other_ck" CHECK ("doctor_desk_acts"."choice" <> 'other' or length(btrim(coalesce("doctor_desk_acts"."note", ''))) between 3 and 200),
	CONSTRAINT "doctor_desk_acts_order_ck" CHECK ("doctor_desk_acts"."acted_at" >= "doctor_desk_acts"."opened_at")
);
--> statement-breakpoint
CREATE TABLE "doctor_desk_moves" (
	"id" text PRIMARY KEY NOT NULL,
	"row_key" text NOT NULL,
	"team_id" text NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"moved_by" text NOT NULL,
	"alert_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_desk_moves_not_same_ck" CHECK ("doctor_desk_moves"."from_user_id" <> "doctor_desk_moves"."to_user_id")
);
--> statement-breakpoint
CREATE TABLE "doctor_desk_ratings" (
	"id" text PRIMARY KEY NOT NULL,
	"work_kind" text NOT NULL,
	"work_id" text NOT NULL,
	"work_date" date NOT NULL,
	"rated_user_id" text NOT NULL,
	"rater_id" text NOT NULL,
	"team_id" text NOT NULL,
	"department_id" text NOT NULL,
	"rating" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_desk_ratings_kind_ck" CHECK ("doctor_desk_ratings"."work_kind" in ('opd_visit')),
	CONSTRAINT "doctor_desk_ratings_rating_ck" CHECK ("doctor_desk_ratings"."rating" in ('good', 'fine', 'needs_rework')),
	CONSTRAINT "doctor_desk_ratings_not_self_ck" CHECK ("doctor_desk_ratings"."rater_id" <> "doctor_desk_ratings"."rated_user_id"),
	CONSTRAINT "doctor_desk_ratings_reason_ck" CHECK ("doctor_desk_ratings"."rating" <> 'needs_rework' or length(btrim(coalesce("doctor_desk_ratings"."reason", ''))) between 3 and 200),
	CONSTRAINT "doctor_desk_ratings_reason_len_ck" CHECK ("doctor_desk_ratings"."reason" is null or length("doctor_desk_ratings"."reason") <= 200)
);
--> statement-breakpoint
ALTER TABLE "doctor_desk_acts" ADD CONSTRAINT "doctor_desk_acts_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_desk_acts" ADD CONSTRAINT "doctor_desk_acts_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_desk_moves" ADD CONSTRAINT "doctor_desk_moves_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_desk_moves" ADD CONSTRAINT "doctor_desk_moves_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_desk_moves" ADD CONSTRAINT "doctor_desk_moves_moved_by_users_id_fk" FOREIGN KEY ("moved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_desk_ratings" ADD CONSTRAINT "doctor_desk_ratings_rated_user_id_users_id_fk" FOREIGN KEY ("rated_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_desk_ratings" ADD CONSTRAINT "doctor_desk_ratings_rater_id_users_id_fk" FOREIGN KEY ("rater_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_desk_acts_once_ux" ON "doctor_desk_acts" USING btree ("row_key");--> statement-breakpoint
CREATE INDEX "doctor_desk_acts_team_idx" ON "doctor_desk_acts" USING btree ("team_id","acted_at");--> statement-breakpoint
CREATE INDEX "doctor_desk_acts_actor_idx" ON "doctor_desk_acts" USING btree ("actor_id","acted_at");--> statement-breakpoint
CREATE INDEX "doctor_desk_moves_row_idx" ON "doctor_desk_moves" USING btree ("row_key","created_at");--> statement-breakpoint
CREATE INDEX "doctor_desk_moves_team_idx" ON "doctor_desk_moves" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_desk_ratings_once_ux" ON "doctor_desk_ratings" USING btree ("work_kind","work_id","rater_id");--> statement-breakpoint
CREATE INDEX "doctor_desk_ratings_rated_idx" ON "doctor_desk_ratings" USING btree ("rated_user_id","work_date");--> statement-breakpoint
CREATE INDEX "doctor_desk_ratings_department_idx" ON "doctor_desk_ratings" USING btree ("department_id","work_date");