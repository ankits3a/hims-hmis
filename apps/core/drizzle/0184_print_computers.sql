CREATE TABLE "print_computers" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"printer" text,
	"printers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"platform" text,
	"app_version" text,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_enrolment_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"computer_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "print_computers_agent_ux" ON "print_computers" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "print_enrolment_codes_hash_ux" ON "print_enrolment_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "print_enrolment_codes_expiry_idx" ON "print_enrolment_codes" USING btree ("expires_at");