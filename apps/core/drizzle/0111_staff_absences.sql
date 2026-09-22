-- PHASE R (R4) — absence for every member of staff, what they hold, and the OPD projection.
--
-- ONE hand-written EXCLUDE below, invisible to the drizzle snapshot as in 0109 and 0110;
-- `schema/roster.test.ts` asks `pg_constraint` for it by name. It needs `btree_gist` (0108).
CREATE TABLE "staff_absences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"decided_at" timestamp with time zone,
	"reason" text,
	"aebas_entered_at" timestamp with time zone,
	"aebas_entered_by" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_absences_kind_ck" CHECK ("staff_absences"."kind" in ('CL', 'EL', 'ML', 'maternity', 'paternity', 'comp_off', 'night_off', 'duty_off', 'deputation', 'academic', 'study', 'abstaining', 'unauthorised')),
	CONSTRAINT "staff_absences_status_ck" CHECK ("staff_absences"."status" in ('requested', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "staff_absences_window_ck" CHECK ("staff_absences"."ends_at" > "staff_absences"."starts_at"),
	CONSTRAINT "staff_absences_source_ck" CHECK ("staff_absences"."source" in ('manual', 'import', 'opd', 'academic')),
	CONSTRAINT "staff_absences_decided_ck" CHECK (case
            when "staff_absences"."status" = 'requested' then "staff_absences"."decided_at" is null
            when "staff_absences"."status" in ('approved', 'rejected') then "staff_absences"."decided_at" is not null
            else true
          end
          and ("staff_absences"."decided_at" is null) = ("staff_absences"."approved_by" is null)),
	CONSTRAINT "staff_absences_aebas_ck" CHECK (("staff_absences"."aebas_entered_at" is null) = ("staff_absences"."aebas_entered_by" is null))
);
--> statement-breakpoint
CREATE TABLE "staff_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"credential_key" text NOT NULL,
	"reference" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_credentials_key_ck" CHECK ("staff_credentials"."credential_key" in ('nmr', 'smr', 'nursing_council', 'pharmacy_council', 'bls', 'acls', 'nrp', 'ventilator', 'chemo', 'pcpndt_registered', 'aerb_rso')),
	CONSTRAINT "staff_credentials_window_ck" CHECK ("staff_credentials"."valid_to" is null or "staff_credentials"."valid_to" > "staff_credentials"."valid_from"),
	CONSTRAINT "staff_credentials_reference_ck" CHECK (length(btrim("staff_credentials"."reference")) between 1 and 120),
	CONSTRAINT "staff_credentials_verified_ck" CHECK (("staff_credentials"."verified_by" is null) = ("staff_credentials"."verified_at" is null))
);
--> statement-breakpoint
ALTER TABLE "opd_doctor_leaves" ADD COLUMN "absence_id" text;--> statement-breakpoint
ALTER TABLE "staff_absences" ADD CONSTRAINT "staff_absences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_absences" ADD CONSTRAINT "staff_absences_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_absences" ADD CONSTRAINT "staff_absences_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_absences" ADD CONSTRAINT "staff_absences_aebas_entered_by_users_id_fk" FOREIGN KEY ("aebas_entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_credentials" ADD CONSTRAINT "staff_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_credentials" ADD CONSTRAINT "staff_credentials_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_absences_user_window_idx" ON "staff_absences" USING btree ("user_id","starts_at");--> statement-breakpoint
CREATE INDEX "staff_absences_status_idx" ON "staff_absences" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "staff_credentials_user_idx" ON "staff_credentials" USING btree ("user_id","credential_key");
--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- NOBODY IS ON TWO KINDS OF LEAVE AT ONCE.
--
-- Partial on `status = 'approved'`, and both halves of that matter. Overlapping REQUESTS are
-- normal — somebody asks for the 12th to the 14th, is refused, and asks for the 13th to the 15th —
-- so constraining every row would refuse the ordinary case. Overlapping APPROVALS are not
-- ordinary: they are how one person's absence gets counted twice in an attendance projection, and
-- how a ward is told a resident is away for two different reasons on one night.
ALTER TABLE "staff_absences"
  ADD CONSTRAINT "staff_absences_no_overlap_excl"
  EXCLUDE USING gist (
    "user_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("status" = 'approved');
