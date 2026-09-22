-- PHASE R (R1) — the roster's two master lists, and the extension the phase is built on.
--
-- `btree_gist` IS CREATED HERE AND USED BY NOBODY UNTIL R2, because the plan puts it here (§4 R1).
-- R2's exclusion constraints — "one person, one place" and "one published period per scope per
-- instant" — need gist indexing over TEXT equality, which core Postgres does not provide. Creating
-- it in its own additive migration keeps R2's migration about R2's tables, and keeps the one
-- statement in this phase that is not a table where a reader looking for it will find it first.
-- 0021's `pg_trgm` is the precedent for creating an extension in a migration at all.
--
-- It is invisible to the drizzle snapshot: drizzle-kit does not model extensions, so a later
-- `generate` will neither recreate nor drop this line. `roster.test.ts` is what knows it exists,
-- and it asks `pg_extension` rather than trusting this file.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TABLE "org_departments" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"admitting" boolean DEFAULT false NOT NULL,
	"opd_department_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_departments_kind_ck" CHECK ("org_departments"."kind" in ('clinical', 'para_clinical', 'support', 'nursing', 'admin')),
	CONSTRAINT "org_departments_validity_ck" CHECK ("org_departments"."valid_to" is null or "org_departments"."valid_to" > "org_departments"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "roster_positions" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"cadre" text NOT NULL,
	"ladder_rank" integer NOT NULL,
	"eligible_role_key" text,
	"default_mode" text DEFAULT 'presence' NOT NULL,
	"max_presence_hours" integer NOT NULL,
	"counts_toward_requirements" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_positions_cadre_ck" CHECK ("roster_positions"."cadre" in ('faculty', 'senior_resident', 'junior_resident', 'intern', 'medical_officer', 'nurse', 'technician', 'pharmacist', 'admin', 'support')),
	CONSTRAINT "roster_positions_default_mode_ck" CHECK ("roster_positions"."default_mode" in ('presence', 'call')),
	CONSTRAINT "roster_positions_ladder_rank_ck" CHECK ("roster_positions"."ladder_rank" >= 1),
	CONSTRAINT "roster_positions_max_presence_ck" CHECK ("roster_positions"."max_presence_hours" between 1 and 36)
);
--> statement-breakpoint
ALTER TABLE "org_departments" ADD CONSTRAINT "org_departments_opd_department_id_opd_departments_id_fk" FOREIGN KEY ("opd_department_id") REFERENCES "public"."opd_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_positions" ADD CONSTRAINT "roster_positions_eligible_role_key_roles_key_fk" FOREIGN KEY ("eligible_role_key") REFERENCES "public"."roles"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_departments_code_ux" ON "org_departments" USING btree ("site_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "org_departments_opd_department_ux" ON "org_departments" USING btree ("opd_department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roster_positions_label_ux" ON "roster_positions" USING btree ("label");