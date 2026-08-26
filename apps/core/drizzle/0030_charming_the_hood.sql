--> PLAN 09a CLOSE — statement order is HAND-CORRECTED and must stay this way.
--> `drizzle-kit generate` emitted the FOREIGN KEY first and the UNIQUE it references second, which
--> is unrunnable: `ERROR: there is no unique constraint matching given keys for referenced table
--> "commission_accrual_subjects"`. Measured — four suites, 69 tests, every one failing on that line.
--> The unique constraint therefore comes FIRST here. Nothing else about the file is edited, and
--> `_journal.json` is untouched (AGENT-RULES §6).
ALTER TABLE "commission_accrual_subjects" ADD CONSTRAINT "commission_accrual_subjects_id_counterparty_ux" UNIQUE("id","counterparty_id");--> statement-breakpoint
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_subject_counterparty_fk" FOREIGN KEY ("subject_id","counterparty_id") REFERENCES "public"."commission_accrual_subjects"("id","counterparty_id") ON DELETE no action ON UPDATE no action;
