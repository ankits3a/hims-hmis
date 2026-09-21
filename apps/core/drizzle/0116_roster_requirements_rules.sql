CREATE TABLE "roster_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"period_id" text NOT NULL,
	"assignment_id" text,
	"user_id" text,
	"rule_key" text NOT NULL,
	"severity" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"accept_reason" text,
	"cleared_at" timestamp with time zone,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_findings_severity_ck" CHECK ("roster_findings"."severity" in ('block', 'warn', 'info')),
	CONSTRAINT "roster_findings_acceptance_ck" CHECK (("roster_findings"."accepted_by" is null and "roster_findings"."accepted_at" is null and "roster_findings"."accept_reason" is null) or ("roster_findings"."accepted_by" is not null and "roster_findings"."accepted_at" is not null and "roster_findings"."accept_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "roster_mode_declarations" (
	"id" text PRIMARY KEY NOT NULL,
	"department_id" text,
	"mode" text DEFAULT 'skeleton' NOT NULL,
	"ist_date" date NOT NULL,
	"reason" text NOT NULL,
	"declared_by" text NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_by" text,
	"withdrawn_at" timestamp with time zone,
	"withdraw_reason" text,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_mode_declarations_mode_ck" CHECK ("roster_mode_declarations"."mode" in ('skeleton')),
	CONSTRAINT "roster_mode_declarations_withdrawal_ck" CHECK (("roster_mode_declarations"."withdrawn_at" is null and "roster_mode_declarations"."withdrawn_by" is null)
          or ("roster_mode_declarations"."withdrawn_at" is not null and "roster_mode_declarations"."withdrawn_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "roster_requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"position_key" text NOT NULL,
	"shift_def_id" text,
	"day_class" text DEFAULT 'any' NOT NULL,
	"min_count" integer NOT NULL,
	"max_count" integer,
	"credential_key" text,
	"basis" text DEFAULT 'fixed' NOT NULL,
	"ratio_n" integer,
	"authority" text NOT NULL,
	"citation" text,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_requirements_scope_ck" CHECK ("roster_requirements"."scope_type" in ('location', 'team', 'department')),
	CONSTRAINT "roster_requirements_day_class_ck" CHECK ("roster_requirements"."day_class" in ('weekday', 'saturday', 'sunday', 'holiday', 'any')),
	CONSTRAINT "roster_requirements_basis_ck" CHECK ("roster_requirements"."basis" in ('fixed', 'per_occupied_bed')),
	CONSTRAINT "roster_requirements_authority_ck" CHECK ("roster_requirements"."authority" in ('nmc', 'nmc_recommended', 'central_law', 'central_directive', 'court', 'accreditation', 'state', 'institution')),
	CONSTRAINT "roster_requirements_min_ck" CHECK ("roster_requirements"."min_count" >= 0),
	CONSTRAINT "roster_requirements_max_ck" CHECK ("roster_requirements"."max_count" is null or "roster_requirements"."max_count" >= "roster_requirements"."min_count"),
	CONSTRAINT "roster_requirements_ratio_ck" CHECK (("roster_requirements"."basis" = 'fixed' and "roster_requirements"."ratio_n" is null) or ("roster_requirements"."basis" = 'per_occupied_bed' and "roster_requirements"."ratio_n" > 0)),
	CONSTRAINT "roster_requirements_validity_ck" CHECK ("roster_requirements"."valid_to" is null or "roster_requirements"."valid_to" >= "roster_requirements"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "roster_rule_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"department_id" text NOT NULL,
	"rule_key" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_rule_profiles_validity_ck" CHECK ("roster_rule_profiles"."valid_to" >= "roster_rule_profiles"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "roster_rules" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"severity" text NOT NULL,
	"authority" text NOT NULL,
	"citation" text,
	"applies_to" text[] DEFAULT '{}'::text[] NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_rules_severity_ck" CHECK ("roster_rules"."severity" in ('block', 'warn', 'info')),
	CONSTRAINT "roster_rules_authority_ck" CHECK ("roster_rules"."authority" in ('nmc', 'nmc_recommended', 'central_law', 'central_directive', 'court', 'accreditation', 'state', 'institution'))
);
--> statement-breakpoint
ALTER TABLE "roster_findings" ADD CONSTRAINT "roster_findings_period_id_roster_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."roster_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_findings" ADD CONSTRAINT "roster_findings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_findings" ADD CONSTRAINT "roster_findings_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_mode_declarations" ADD CONSTRAINT "roster_mode_declarations_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_mode_declarations" ADD CONSTRAINT "roster_mode_declarations_declared_by_users_id_fk" FOREIGN KEY ("declared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_mode_declarations" ADD CONSTRAINT "roster_mode_declarations_withdrawn_by_users_id_fk" FOREIGN KEY ("withdrawn_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_requirements" ADD CONSTRAINT "roster_requirements_position_key_roster_positions_key_fk" FOREIGN KEY ("position_key") REFERENCES "public"."roster_positions"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_requirements" ADD CONSTRAINT "roster_requirements_shift_def_id_roster_shift_defs_id_fk" FOREIGN KEY ("shift_def_id") REFERENCES "public"."roster_shift_defs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_rule_profiles" ADD CONSTRAINT "roster_rule_profiles_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_rule_profiles" ADD CONSTRAINT "roster_rule_profiles_rule_key_roster_rules_key_fk" FOREIGN KEY ("rule_key") REFERENCES "public"."roster_rules"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_rule_profiles" ADD CONSTRAINT "roster_rule_profiles_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roster_findings_period_idx" ON "roster_findings" USING btree ("period_id") WHERE "roster_findings"."cleared_at" is null;--> statement-breakpoint
CREATE INDEX "roster_findings_user_idx" ON "roster_findings" USING btree ("user_id","rule_key");--> statement-breakpoint
CREATE INDEX "roster_mode_declarations_day_idx" ON "roster_mode_declarations" USING btree ("ist_date","department_id") WHERE "roster_mode_declarations"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "roster_requirements_scope_idx" ON "roster_requirements" USING btree ("scope_type","scope_id") WHERE "roster_requirements"."active";--> statement-breakpoint
CREATE INDEX "roster_rule_profiles_dept_idx" ON "roster_rule_profiles" USING btree ("department_id","rule_key","valid_from");