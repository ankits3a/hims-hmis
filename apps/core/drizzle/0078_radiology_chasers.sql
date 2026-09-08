CREATE TABLE "imaging_report_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"first_read_at" timestamp with time zone,
	"first_read_by" text,
	"unread_chased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imaging_report_delivery_first_read_ck" CHECK (("imaging_report_delivery"."first_read_by" is null) = ("imaging_report_delivery"."first_read_at" is null))
);
--> statement-breakpoint
ALTER TABLE "imaging_critical_findings" ADD COLUMN "chased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imaging_report_delivery" ADD CONSTRAINT "imaging_report_delivery_report_id_imaging_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."imaging_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_report_delivery_report_ux" ON "imaging_report_delivery" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "imaging_report_delivery_unread_idx" ON "imaging_report_delivery" USING btree ("first_read_at","unread_chased_at");--> statement-breakpoint
CREATE INDEX "imaging_critical_findings_chase_idx" ON "imaging_critical_findings" USING btree ("acknowledged_at","chased_at","created_at");