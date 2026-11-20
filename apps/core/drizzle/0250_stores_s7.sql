CREATE TABLE "stores_par_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"suggestion_id" text NOT NULL,
	"kind" text NOT NULL,
	"store_id" text NOT NULL,
	"item_id" text NOT NULL,
	"department_id" text NOT NULL,
	"quarter" text NOT NULL,
	"old_min" integer,
	"old_reorder" integer,
	"old_max" integer,
	"min_base" integer NOT NULL,
	"reorder_base" integer NOT NULL,
	"max_base" integer NOT NULL,
	"use_per_day" double precision NOT NULL,
	"supply_interval_days" double precision NOT NULL,
	"inputs" jsonb NOT NULL,
	"confirm_id" text,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_par_suggestions_ck" CHECK ("stores_par_suggestions"."kind" in ('suggested', 'accepted', 'kept') and "stores_par_suggestions"."min_base" >= 0 and "stores_par_suggestions"."min_base" <= "stores_par_suggestions"."reorder_base"
      and "stores_par_suggestions"."reorder_base" < "stores_par_suggestions"."max_base")
);
--> statement-breakpoint
CREATE TABLE "stores_planner_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"kind" text NOT NULL,
	"proposal" text NOT NULL,
	"store_id" text NOT NULL,
	"department_id" text NOT NULL,
	"item_id" text,
	"qty" integer,
	"warning_id" text,
	"forecast_id" text,
	"indent_id" text,
	"reason" text,
	"data" jsonb,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_planner_drafts_ck" CHECK ("stores_planner_drafts"."kind" in ('open', 'line', 'line_withdrawn', 'sent', 'not_now', 'withdrawn')
      and "stores_planner_drafts"."proposal" in ('topup', 'slow') and ("stores_planner_drafts"."qty" is null or "stores_planner_drafts"."qty" > 0))
);
--> statement-breakpoint
CREATE TABLE "stores_planner_forecasts" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"item_id" text NOT NULL,
	"department_id" text,
	"scope" text NOT NULL,
	"method" text NOT NULL,
	"weeks" integer NOT NULL,
	"use_per_day" double precision NOT NULL,
	"on_hand" integer NOT NULL,
	"on_way" integer NOT NULL,
	"min_base" integer,
	"reorder_base" integer,
	"max_base" integer,
	"hours_to_zero" double precision,
	"inputs" jsonb NOT NULL,
	"made_by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_planner_forecasts_ck" CHECK ("stores_planner_forecasts"."scope" in ('shelf', 'central') and "stores_planner_forecasts"."method" in ('learning', 'plain', 'workload') and "stores_planner_forecasts"."use_per_day" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stores_planner_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"department_id" text,
	"paused" boolean DEFAULT false NOT NULL,
	"t3" boolean DEFAULT false NOT NULL,
	"safety_days" jsonb,
	"cover_days" jsonb,
	"reason" text,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_planner_settings_ck" CHECK ("stores_planner_settings"."kind" in ('settings', 'owner_t3'))
);
--> statement-breakpoint
CREATE TABLE "stores_planner_warnings" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"item_id" text NOT NULL,
	"department_id" text NOT NULL,
	"kind" text NOT NULL,
	"rule" text,
	"urgent" boolean DEFAULT false NOT NULL,
	"hours_to_zero" double precision,
	"on_hand" integer NOT NULL,
	"on_way" integer NOT NULL,
	"forecast_id" text,
	"source" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_planner_warnings_ck" CHECK ("stores_planner_warnings"."kind" in ('warn', 'recovered') and "stores_planner_warnings"."source" in ('night', 'use', 'receipt')
      and ("stores_planner_warnings"."rule" is null or "stores_planner_warnings"."rule" in ('hours', 'reorder')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "stores_par_suggestions_once_ux" ON "stores_par_suggestions" USING btree ("store_id","item_id","quarter") WHERE "stores_par_suggestions"."kind" = 'suggested';--> statement-breakpoint
CREATE UNIQUE INDEX "stores_par_suggestions_close_ux" ON "stores_par_suggestions" USING btree ("suggestion_id") WHERE "stores_par_suggestions"."kind" in ('accepted', 'kept');--> statement-breakpoint
CREATE INDEX "stores_par_suggestions_store_idx" ON "stores_par_suggestions" USING btree ("store_id","at");--> statement-breakpoint
CREATE INDEX "stores_planner_drafts_draft_idx" ON "stores_planner_drafts" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "stores_planner_drafts_store_idx" ON "stores_planner_drafts" USING btree ("store_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_planner_drafts_close_ux" ON "stores_planner_drafts" USING btree ("draft_id") WHERE "stores_planner_drafts"."kind" in ('sent', 'not_now', 'withdrawn');--> statement-breakpoint
CREATE INDEX "stores_planner_forecasts_item_idx" ON "stores_planner_forecasts" USING btree ("store_id","item_id","at");--> statement-breakpoint
CREATE INDEX "stores_planner_settings_dept_idx" ON "stores_planner_settings" USING btree ("department_id","at");--> statement-breakpoint
CREATE INDEX "stores_planner_warnings_item_idx" ON "stores_planner_warnings" USING btree ("store_id","item_id","at");--> statement-breakpoint
CREATE INDEX "stores_planner_warnings_at_idx" ON "stores_planner_warnings" USING btree ("at");--> statement-breakpoint
CREATE TRIGGER stores_planner_forecasts_append_only BEFORE UPDATE OR DELETE ON stores_planner_forecasts
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_planner_warnings_append_only BEFORE UPDATE OR DELETE ON stores_planner_warnings
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_planner_drafts_append_only BEFORE UPDATE OR DELETE ON stores_planner_drafts
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_par_suggestions_append_only BEFORE UPDATE OR DELETE ON stores_par_suggestions
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_planner_settings_append_only BEFORE UPDATE OR DELETE ON stores_planner_settings
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();
