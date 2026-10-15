CREATE TABLE "copilot_ask_feedback" (
	"ask_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"verdict" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copilot_ask_feedback_verdict_ck" CHECK ("copilot_ask_feedback"."verdict" in ('wrong'))
);
--> statement-breakpoint
CREATE INDEX "copilot_ask_feedback_at_idx" ON "copilot_ask_feedback" USING btree ("at");