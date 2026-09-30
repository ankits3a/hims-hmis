CREATE TABLE "lapsed_restore_checks" (
	"movement_id" text PRIMARY KEY NOT NULL,
	"checked_by" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patient_match_queue" ADD COLUMN "dismiss_reason" text;--> statement-breakpoint
ALTER TABLE "lapsed_restore_checks" ADD CONSTRAINT "lapsed_restore_checks_movement_id_entitlement_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."entitlement_movements"("id") ON DELETE no action ON UPDATE no action;