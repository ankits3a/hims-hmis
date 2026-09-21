ALTER TABLE "alerts" ADD COLUMN "ack_kind" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "owned_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "ack_note" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "handed_to_user_id" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "ack_extensions" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_handed_to_user_id_users_id_fk" FOREIGN KEY ("handed_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_ack_kind_ck" CHECK ("alerts"."ack_kind" in ('seen', 'owned', 'handed_over'));--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_ack_ck" CHECK (("alerts"."ack_kind" is null) = ("alerts"."acknowledged_at" is null));--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_ack_owned_ck" CHECK ("alerts"."ack_kind" <> 'owned' or "alerts"."owned_until" is not null);--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_ack_handover_ck" CHECK ("alerts"."ack_kind" <> 'handed_over' or "alerts"."handed_to_user_id" is not null);