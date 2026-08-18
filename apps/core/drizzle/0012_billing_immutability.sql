CREATE FUNCTION billing_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'billing_immutable: % rows are append-only (% refused)', TG_TABLE_NAME, TG_OP; END $$;--> statement-breakpoint
CREATE TRIGGER invoices_immutable BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION billing_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER invoice_lines_immutable BEFORE UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION billing_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER credit_notes_immutable BEFORE UPDATE OR DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION billing_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER credit_note_lines_immutable BEFORE UPDATE OR DELETE ON credit_note_lines FOR EACH ROW EXECUTE FUNCTION billing_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER receipts_immutable BEFORE UPDATE OR DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION billing_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER allocations_immutable BEFORE UPDATE OR DELETE ON allocations FOR EACH ROW EXECUTE FUNCTION billing_forbid_mutation();
