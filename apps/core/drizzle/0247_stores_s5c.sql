CREATE TABLE "stores_agent_proposal_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"kind" text NOT NULL,
	"line_idx" integer,
	"data" jsonb,
	"confirm_id" text,
	"result_row_id" text,
	"reason" text,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_agent_proposal_steps_kind_ck" CHECK ("stores_agent_proposal_steps"."kind" in ('confirmed', 'dismissed', 'superseded', 'line_confirmed', 'line_dropped')),
	CONSTRAINT "stores_agent_proposal_steps_line_ck" CHECK (("stores_agent_proposal_steps"."kind" in ('line_confirmed', 'line_dropped')) = ("stores_agent_proposal_steps"."line_idx" is not null))
);
--> statement-breakpoint
CREATE TABLE "stores_agent_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"department_ids" jsonb NOT NULL,
	"group_id" text,
	"rfq_id" text,
	"vendor_id" text,
	"payload" jsonb NOT NULL,
	"document_key" text,
	"made_by" text NOT NULL,
	"made_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_agent_proposals_kind_ck" CHECK ("stores_agent_proposals"."kind" in ('grouping', 'rfq_draft', 'quote_read', 'po_draft'))
);
--> statement-breakpoint
CREATE TABLE "stores_buy_exception_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"exception_id" text NOT NULL,
	"kind" text NOT NULL,
	"as_role" text NOT NULL,
	"reason" text,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_buy_exception_steps_kind_ck" CHECK ("stores_buy_exception_steps"."kind" in ('certified', 'approved', 'confirmed', 'refused')),
	CONSTRAINT "stores_buy_exception_steps_reason_ck" CHECK ("stores_buy_exception_steps"."kind" <> 'refused' or "stores_buy_exception_steps"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "stores_buy_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"group_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"reason" text NOT NULL,
	"value_paise" bigint NOT NULL,
	"needs_owner" boolean NOT NULL,
	"raised_by" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_buy_exceptions_kind_ck" CHECK ("stores_buy_exceptions"."kind" in ('single_source', 'emergency')),
	CONSTRAINT "stores_buy_exceptions_value_ck" CHECK ("stores_buy_exceptions"."value_paise" >= 0 and length("stores_buy_exceptions"."reason") > 0)
);
--> statement-breakpoint
CREATE TABLE "stores_po_advance_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"advance_id" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_po_advance_steps_kind_ck" CHECK ("stores_po_advance_steps"."kind" in ('approved', 'refused')),
	CONSTRAINT "stores_po_advance_steps_reason_ck" CHECK ("stores_po_advance_steps"."kind" <> 'refused' or "stores_po_advance_steps"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "stores_po_advances" (
	"id" text PRIMARY KEY NOT NULL,
	"po_id" text NOT NULL,
	"pct_bps" integer NOT NULL,
	"amount_paise" bigint NOT NULL,
	"guarantee_no" text NOT NULL,
	"guarantee_bank" text NOT NULL,
	"guarantee_valid_to" date NOT NULL,
	"guarantee_paise" bigint NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stores_po_advances_pct_ck" CHECK ("stores_po_advances"."pct_bps" > 0 and "stores_po_advances"."pct_bps" <= 3000),
	CONSTRAINT "stores_po_advances_money_ck" CHECK ("stores_po_advances"."amount_paise" > 0 and "stores_po_advances"."guarantee_paise" >= "stores_po_advances"."amount_paise")
);
--> statement-breakpoint
ALTER TABLE "stores_agent_proposal_steps" ADD CONSTRAINT "stores_agent_proposal_steps_proposal_id_stores_agent_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."stores_agent_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_agent_proposals" ADD CONSTRAINT "stores_agent_proposals_group_id_stores_buy_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."stores_buy_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_agent_proposals" ADD CONSTRAINT "stores_agent_proposals_rfq_id_stores_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."stores_rfqs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_agent_proposals" ADD CONSTRAINT "stores_agent_proposals_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_buy_exception_steps" ADD CONSTRAINT "stores_buy_exception_steps_exception_id_stores_buy_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."stores_buy_exceptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_buy_exceptions" ADD CONSTRAINT "stores_buy_exceptions_group_id_stores_buy_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."stores_buy_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_buy_exceptions" ADD CONSTRAINT "stores_buy_exceptions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores_po_advance_steps" ADD CONSTRAINT "stores_po_advance_steps_advance_id_stores_po_advances_id_fk" FOREIGN KEY ("advance_id") REFERENCES "public"."stores_po_advances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stores_agent_proposal_steps_proposal_idx" ON "stores_agent_proposal_steps" USING btree ("proposal_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_agent_proposal_steps_close_ux" ON "stores_agent_proposal_steps" USING btree ("proposal_id") WHERE "stores_agent_proposal_steps"."kind" in ('confirmed', 'dismissed', 'superseded');--> statement-breakpoint
CREATE UNIQUE INDEX "stores_agent_proposal_steps_line_ux" ON "stores_agent_proposal_steps" USING btree ("proposal_id","line_idx") WHERE "stores_agent_proposal_steps"."kind" in ('line_confirmed', 'line_dropped');--> statement-breakpoint
CREATE INDEX "stores_agent_proposals_kind_idx" ON "stores_agent_proposals" USING btree ("kind","made_at");--> statement-breakpoint
CREATE INDEX "stores_agent_proposals_group_idx" ON "stores_agent_proposals" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_buy_exception_steps_once_ux" ON "stores_buy_exception_steps" USING btree ("exception_id","kind");--> statement-breakpoint
CREATE INDEX "stores_buy_exceptions_group_idx" ON "stores_buy_exceptions" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_po_advance_steps_once_ux" ON "stores_po_advance_steps" USING btree ("advance_id");--> statement-breakpoint
CREATE INDEX "stores_po_advances_po_idx" ON "stores_po_advances" USING btree ("po_id");--> statement-breakpoint
CREATE TRIGGER stores_agent_proposals_append_only BEFORE UPDATE OR DELETE ON stores_agent_proposals
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_agent_proposal_steps_append_only BEFORE UPDATE OR DELETE ON stores_agent_proposal_steps
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_buy_exceptions_append_only BEFORE UPDATE OR DELETE ON stores_buy_exceptions
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_buy_exception_steps_append_only BEFORE UPDATE OR DELETE ON stores_buy_exception_steps
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_po_advances_append_only BEFORE UPDATE OR DELETE ON stores_po_advances
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();--> statement-breakpoint
CREATE TRIGGER stores_po_advance_steps_append_only BEFORE UPDATE OR DELETE ON stores_po_advance_steps
  FOR EACH ROW EXECUTE FUNCTION stores_assets_append_only();
