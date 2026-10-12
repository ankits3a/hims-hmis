CREATE TABLE "outside_tests" (
	"service_id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"site" text DEFAULT 'outside' NOT NULL,
	"department" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outside_tests_code_unique" UNIQUE("code"),
	CONSTRAINT "outside_tests_site_ck" CHECK ("outside_tests"."site" in ('outside', 'in_hospital')),
	CONSTRAINT "outside_tests_department_ck" CHECK ("outside_tests"."site" = 'outside' or "outside_tests"."department" is not null)
);
--> statement-breakpoint
ALTER TABLE "imaging_studies" DROP CONSTRAINT "imaging_studies_authorised_by_ck";--> statement-breakpoint
ALTER TABLE "outside_tests" ADD CONSTRAINT "outside_tests_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outside_tests_active_idx" ON "outside_tests" USING btree ("active");--> statement-breakpoint
ALTER TABLE "imaging_studies" ADD CONSTRAINT "imaging_studies_authorised_by_ck" CHECK ("imaging_studies"."authorised_by" is null or "imaging_studies"."authorised_by" in ('invoice', 'payer_branch', 'daycare', 'stat', 'free'));