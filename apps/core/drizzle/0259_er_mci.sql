CREATE TABLE "er_mci_events" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"place" text,
	"note" text,
	"event_account_id" text NOT NULL,
	"declared_by" text NOT NULL,
	"declared_at" timestamp with time zone NOT NULL,
	"stood_down_by" text,
	"stood_down_at" timestamp with time zone,
	"stand_down_note" text,
	CONSTRAINT "er_mci_events_stood_down_ck" CHECK (("er_mci_events"."stood_down_at" is null) = ("er_mci_events"."stood_down_by" is null))
);
--> statement-breakpoint
CREATE TABLE "er_mci_packs" (
	"id" text PRIMARY KEY NOT NULL,
	"pack_no" text NOT NULL,
	"pack_year" integer NOT NULL,
	"pack_serial" integer NOT NULL,
	"patient_id" text NOT NULL,
	"alias" text NOT NULL,
	"minted_by" text NOT NULL,
	"minted_at" timestamp with time zone NOT NULL,
	"used_episode_id" text,
	"used_at" timestamp with time zone,
	CONSTRAINT "er_mci_packs_used_ck" CHECK (("er_mci_packs"."used_episode_id" is null) = ("er_mci_packs"."used_at" is null))
);
--> statement-breakpoint
CREATE TABLE "er_mci_surge_beds" (
	"id" text PRIMARY KEY NOT NULL,
	"mci_id" text NOT NULL,
	"bed_id" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "er_mci_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"mci_id" text NOT NULL,
	"episode_id" text NOT NULL,
	"tag" text NOT NULL,
	"previous" text,
	"method" text,
	"findings" jsonb,
	"proposal" text,
	"reason" text,
	"tagged_by" text NOT NULL,
	"tagged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "er_mci_tags_tag_ck" CHECK ("er_mci_tags"."tag" in ('red', 'yellow', 'green', 'black')),
	CONSTRAINT "er_mci_tags_method_ck" CHECK ("er_mci_tags"."method" is null or "er_mci_tags"."method" in ('start', 'jumpstart'))
);
--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "mci_id" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "mci_tag" text;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD COLUMN "mci_pack_no" text;--> statement-breakpoint
ALTER TABLE "er_mci_events" ADD CONSTRAINT "er_mci_events_event_account_id_er_event_accounts_id_fk" FOREIGN KEY ("event_account_id") REFERENCES "public"."er_event_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_mci_packs" ADD CONSTRAINT "er_mci_packs_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_mci_packs" ADD CONSTRAINT "er_mci_packs_used_episode_id_er_episodes_id_fk" FOREIGN KEY ("used_episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_mci_surge_beds" ADD CONSTRAINT "er_mci_surge_beds_mci_id_er_mci_events_id_fk" FOREIGN KEY ("mci_id") REFERENCES "public"."er_mci_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_mci_surge_beds" ADD CONSTRAINT "er_mci_surge_beds_bed_id_resources_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_mci_tags" ADD CONSTRAINT "er_mci_tags_mci_id_er_mci_events_id_fk" FOREIGN KEY ("mci_id") REFERENCES "public"."er_mci_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "er_mci_tags" ADD CONSTRAINT "er_mci_tags_episode_id_er_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."er_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "er_mci_events_running_ux" ON "er_mci_events" USING btree (("stood_down_at" is null)) WHERE "er_mci_events"."stood_down_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "er_mci_packs_no_ux" ON "er_mci_packs" USING btree ("pack_no");--> statement-breakpoint
CREATE UNIQUE INDEX "er_mci_packs_year_serial_ux" ON "er_mci_packs" USING btree ("pack_year","pack_serial");--> statement-breakpoint
CREATE UNIQUE INDEX "er_mci_packs_episode_ux" ON "er_mci_packs" USING btree ("used_episode_id") WHERE "er_mci_packs"."used_episode_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "er_mci_surge_beds_ux" ON "er_mci_surge_beds" USING btree ("mci_id","bed_id");--> statement-breakpoint
CREATE INDEX "er_mci_tags_episode_idx" ON "er_mci_tags" USING btree ("episode_id","tagged_at");--> statement-breakpoint
CREATE INDEX "er_episodes_mci_idx" ON "er_episodes" USING btree ("mci_id") WHERE "er_episodes"."mci_id" is not null;--> statement-breakpoint
ALTER TABLE "er_episodes" ADD CONSTRAINT "er_episodes_mci_tag_ck" CHECK ("er_episodes"."mci_tag" is null or "er_episodes"."mci_tag" in ('red', 'yellow', 'green', 'black'));--> statement-breakpoint
CREATE FUNCTION er_mci_tag_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'er_mci_tags_append_only: % rows are never edited or deleted (% refused)', TG_TABLE_NAME, TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER er_mci_tags_append_only BEFORE UPDATE OR DELETE ON er_mci_tags FOR EACH ROW EXECUTE FUNCTION er_mci_tag_forbid_mutation();
