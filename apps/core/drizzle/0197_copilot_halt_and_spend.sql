CREATE TABLE "copilot_halts" (
	"scope" text PRIMARY KEY NOT NULL,
	"halted_by" text NOT NULL,
	"halted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	CONSTRAINT "copilot_halts_scope_ck" CHECK ("copilot_halts"."scope" in ('read', 'act', 'draft', 'global'))
);
--> statement-breakpoint
ALTER TABLE "copilot_asks" ADD COLUMN "model_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "copilot_asks" ADD COLUMN "cost_micro_inr" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "copilot_asks" ADD COLUMN "model_usage" jsonb;--> statement-breakpoint
ALTER TABLE "copilot_asks" ADD COLUMN "capped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "copilot_asks_spend_idx" ON "copilot_asks" USING btree ("at","cost_micro_inr") WHERE cost_micro_inr > 0;--> statement-breakpoint
ALTER TABLE "copilot_asks" ADD CONSTRAINT "copilot_asks_cost_ck" CHECK ("copilot_asks"."model_calls" >= 0 and "copilot_asks"."cost_micro_inr" >= 0);