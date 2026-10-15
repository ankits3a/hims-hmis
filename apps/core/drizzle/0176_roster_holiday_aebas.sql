ALTER TABLE "roster_holidays" ADD COLUMN "aebas_entered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "roster_holidays" ADD COLUMN "aebas_entered_by" text;--> statement-breakpoint
ALTER TABLE "roster_holidays" ADD CONSTRAINT "roster_holidays_aebas_entered_by_users_id_fk" FOREIGN KEY ("aebas_entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_holidays" ADD CONSTRAINT "roster_holidays_aebas_ck" CHECK (("roster_holidays"."aebas_entered_at" is null) = ("roster_holidays"."aebas_entered_by" is null));