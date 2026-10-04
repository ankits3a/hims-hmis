CREATE TABLE "roster_board_prints" (
	"id" text PRIMARY KEY NOT NULL,
	"slot_at" timestamp with time zone NOT NULL,
	"rendered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"html" text NOT NULL,
	"outcome" text NOT NULL,
	"destinations" text[] DEFAULT '{}'::text[] NOT NULL,
	"print_job_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"site_id" text DEFAULT 'main' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_board_prints_outcome_ck" CHECK ("roster_board_prints"."outcome" in ('queued', 'no_printer')),
	CONSTRAINT "roster_board_prints_jobs_ck" CHECK (("roster_board_prints"."outcome" = 'queued') = (cardinality("roster_board_prints"."print_job_ids") > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "roster_board_prints_slot_ux" ON "roster_board_prints" USING btree ("slot_at");