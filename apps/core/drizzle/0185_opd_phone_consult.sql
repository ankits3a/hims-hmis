CREATE TABLE "opd_lasa_pairs" (
	"id" text PRIMARY KEY NOT NULL,
	"name_a" text NOT NULL,
	"name_b" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opd_lasa_pairs_order_ck" CHECK ("opd_lasa_pairs"."name_a" < "opd_lasa_pairs"."name_b" and "opd_lasa_pairs"."name_a" = lower("opd_lasa_pairs"."name_a") and "opd_lasa_pairs"."name_b" = lower("opd_lasa_pairs"."name_b")),
	CONSTRAINT "opd_lasa_pairs_reviewed_ck" CHECK (("opd_lasa_pairs"."reviewed_by" is null) = ("opd_lasa_pairs"."reviewed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "opd_rx_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"department_id" text,
	"name" text NOT NULL,
	"body" jsonb NOT NULL,
	"signed_by" text,
	"signed_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "opd_rx_sets_scope_ck" CHECK ("opd_rx_sets"."scope" in ('doctor', 'department')),
	CONSTRAINT "opd_rx_sets_owner_ck" CHECK (("opd_rx_sets"."scope" = 'doctor' and "opd_rx_sets"."owner_user_id" is not null and "opd_rx_sets"."department_id" is null) or ("opd_rx_sets"."scope" = 'department' and "opd_rx_sets"."department_id" is not null and "opd_rx_sets"."owner_user_id" is null)),
	CONSTRAINT "opd_rx_sets_signed_ck" CHECK (("opd_rx_sets"."signed_by" is null) = ("opd_rx_sets"."signed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "opd_suggestion_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "opd_suggestion_events_kind_ck" CHECK ("opd_suggestion_events"."kind" in ('medicine', 'test', 'diagnosis')),
	CONSTRAINT "opd_suggestion_events_source_ck" CHECK ("opd_suggestion_events"."source" in ('typed', 'voice', 'search', 'set', 'repeat')),
	CONSTRAINT "opd_suggestion_events_outcome_ck" CHECK ("opd_suggestion_events"."outcome" in ('accepted', 'dismissed', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "opd_term_misses" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"term" text NOT NULL,
	"stage" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "opd_term_misses_kind_ck" CHECK ("opd_term_misses"."kind" in ('medicine', 'test', 'diagnosis')),
	CONSTRAINT "opd_term_misses_stage_ck" CHECK ("opd_term_misses"."stage" in ('search', 'voice')),
	CONSTRAINT "opd_term_misses_term_ck" CHECK (char_length("opd_term_misses"."term") between 2 and 60)
);
--> statement-breakpoint
CREATE TABLE "opd_voice_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"suggestions_enabled" boolean DEFAULT true NOT NULL,
	"model" text DEFAULT 'gpt-4o-transcribe' NOT NULL,
	"daily_minutes_cap" integer DEFAULT 120 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "opd_voice_settings_model_ck" CHECK ("opd_voice_settings"."model" in ('gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1')),
	CONSTRAINT "opd_voice_settings_cap_ck" CHECK ("opd_voice_settings"."daily_minutes_cap" >= 0 and "opd_voice_settings"."daily_minutes_cap" <= 6000)
);
--> statement-breakpoint
CREATE TABLE "opd_voice_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"model" text NOT NULL,
	"seconds" integer NOT NULL,
	"transcript_chars" integer NOT NULL,
	"changed_chars" integer,
	"kept_chars" integer,
	"ok" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "opd_voice_usage_seconds_ck" CHECK ("opd_voice_usage"."seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "opd_rx_sets" ADD CONSTRAINT "opd_rx_sets_department_id_opd_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."opd_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opd_lasa_pairs_pair_uq" ON "opd_lasa_pairs" USING btree ("name_a","name_b");--> statement-breakpoint
CREATE INDEX "opd_rx_sets_owner_idx" ON "opd_rx_sets" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "opd_rx_sets_department_idx" ON "opd_rx_sets" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "opd_suggestion_events_at_idx" ON "opd_suggestion_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "opd_term_misses_kind_term_idx" ON "opd_term_misses" USING btree ("kind","term");--> statement-breakpoint
CREATE INDEX "opd_voice_usage_user_day_idx" ON "opd_voice_usage" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "opd_voice_usage_day_idx" ON "opd_voice_usage" USING btree ("day");--> statement-breakpoint
-- The shipped standard list of look-alike / sound-alike generic names (ISMP-style confused pairs
-- that an Indian OPD formulary carries). NOT pharmacist-reviewed: reviewed_by stays null until this
-- hospital's pharmacist confirms each pair. Hand-written — regenerating this migration loses it.
INSERT INTO "opd_lasa_pairs" ("id", "name_a", "name_b") VALUES
	('lasa_std_01', 'hydralazine', 'hydroxyzine'),
	('lasa_std_02', 'cetirizine', 'sertraline'),
	('lasa_std_03', 'clonazepam', 'clonidine'),
	('lasa_std_04', 'carbamazepine', 'oxcarbazepine'),
	('lasa_std_05', 'chlorpromazine', 'chlorpropamide'),
	('lasa_std_06', 'glimepiride', 'glipizide'),
	('lasa_std_07', 'metformin', 'metronidazole'),
	('lasa_std_08', 'prednisolone', 'prednisone'),
	('lasa_std_09', 'amiloride', 'amlodipine'),
	('lasa_std_10', 'dobutamine', 'dopamine'),
	('lasa_std_11', 'cefazolin', 'ceftriaxone'),
	('lasa_std_12', 'cefixime', 'cefuroxime'),
	('lasa_std_13', 'lamivudine', 'lamotrigine'),
	('lasa_std_14', 'tramadol', 'trazodone'),
	('lasa_std_15', 'vinblastine', 'vincristine'),
	('lasa_std_16', 'quinidine', 'quinine'),
	('lasa_std_17', 'levetiracetam', 'levofloxacin'),
	('lasa_std_18', 'methotrexate', 'metolazone'),
	('lasa_std_19', 'clobazam', 'clonazepam'),
	('lasa_std_20', 'azathioprine', 'azithromycin'),
	('lasa_std_21', 'hydrochlorothiazide', 'hydrocortisone'),
	('lasa_std_22', 'glibenclamide', 'gliclazide'),
	('lasa_std_23', 'ephedrine', 'epinephrine'),
	('lasa_std_24', 'lorazepam', 'losartan')
ON CONFLICT DO NOTHING;
