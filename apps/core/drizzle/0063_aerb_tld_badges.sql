-- PLAN 18c T4 — THE TLD BADGE PROGRAMME, and the one policy number the RSO may set.
--
-- Three tables. `aerb_tld_badges` is the issue: one ACTIVE badge per person and one active badge
-- per number, because a worker wearing two badges has two partial pictures of one exposure and
-- neither is their dose. `aerb_tld_reads` is one laboratory report for one badge over one period,
-- unique on (badge, period) so a re-entered report is a correction rather than a second dose.
--
-- Hp(10) and Hp(0.07) are DIFFERENT DEPTHS, not two names for one number: Hp(10) is the deep dose
-- the effective-dose limits are about, Hp(0.07) the shallow (skin) dose with its own, far higher
-- limit. Storing one and calling it "the dose" is how a skin reading gets compared against a
-- whole-body limit, which is why they are two columns and only one of them is compared.
--
-- `aerb_settings` holds exactly what is POLICY rather than LAW. The statutory limits — 20 mSv/year
-- averaged over five, 30 mSv in any single year, 100 mSv over the five — are code constants in
-- `modules/aerb/limits.ts` with the Rules cited beside them, and no screen may edit them: a
-- hospital that could type its own dose limit would be a hospital whose register proves nothing.
-- The INVESTIGATION LEVEL is the institution's own trigger, set below the limit on purpose, and a
-- hospital choosing a more conservative one must not need a deploy. Default 1.0 mSv/month.
--
-- `investigation_flag` and `investigation_level_msv` travel together (CHECK): a flag with no level
-- is a verdict nobody can check, and a hospital that lowers its level next year must not
-- retroactively turn last year's readings into incidents. The `over_drl` argument, one register over.

CREATE TABLE "aerb_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"investigation_level_msv_per_month" numeric(8, 3) DEFAULT '1.000' NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aerb_settings_level_ck" CHECK ("aerb_settings"."investigation_level_msv_per_month" > 0)
);
--> statement-breakpoint
CREATE TABLE "aerb_tld_badges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"badge_no" text NOT NULL,
	"issued_on" date NOT NULL,
	"returned_on" date,
	"status" text DEFAULT 'active' NOT NULL,
	"remarks" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aerb_tld_badges_status_ck" CHECK ("aerb_tld_badges"."status" in ('active', 'returned', 'lost')),
	CONSTRAINT "aerb_tld_badges_returned_ck" CHECK (("aerb_tld_badges"."status" = 'active') = ("aerb_tld_badges"."returned_on" is null)),
	CONSTRAINT "aerb_tld_badges_dates_ck" CHECK ("aerb_tld_badges"."returned_on" is null or "aerb_tld_badges"."returned_on" >= "aerb_tld_badges"."issued_on")
);
--> statement-breakpoint
CREATE TABLE "aerb_tld_reads" (
	"id" text PRIMARY KEY NOT NULL,
	"badge_id" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"hp10_msv" numeric(8, 3) NOT NULL,
	"hp007_msv" numeric(8, 3),
	"reported_on" date NOT NULL,
	"lab_ref" text,
	"investigation_flag" boolean DEFAULT false NOT NULL,
	"investigation_level_msv" numeric(8, 3),
	"remarks" text,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aerb_tld_reads_period_ck" CHECK ("aerb_tld_reads"."period_end" >= "aerb_tld_reads"."period_start"),
	CONSTRAINT "aerb_tld_reads_hp10_ck" CHECK ("aerb_tld_reads"."hp10_msv" >= 0),
	CONSTRAINT "aerb_tld_reads_hp007_ck" CHECK ("aerb_tld_reads"."hp007_msv" is null or "aerb_tld_reads"."hp007_msv" >= 0),
	CONSTRAINT "aerb_tld_reads_investigation_ck" CHECK ("aerb_tld_reads"."investigation_flag" = false or "aerb_tld_reads"."investigation_level_msv" is not null)
);
--> statement-breakpoint
ALTER TABLE "aerb_tld_badges" ADD CONSTRAINT "aerb_tld_badges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aerb_tld_reads" ADD CONSTRAINT "aerb_tld_reads_badge_id_aerb_tld_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."aerb_tld_badges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aerb_tld_badges_user_active_ux" ON "aerb_tld_badges" USING btree ("user_id") WHERE "aerb_tld_badges"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "aerb_tld_badges_no_active_ux" ON "aerb_tld_badges" USING btree ("badge_no") WHERE "aerb_tld_badges"."status" = 'active';--> statement-breakpoint
CREATE INDEX "aerb_tld_badges_user_idx" ON "aerb_tld_badges" USING btree ("user_id","issued_on");--> statement-breakpoint
CREATE UNIQUE INDEX "aerb_tld_reads_badge_period_ux" ON "aerb_tld_reads" USING btree ("badge_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "aerb_tld_reads_period_idx" ON "aerb_tld_reads" USING btree ("period_start","period_end");