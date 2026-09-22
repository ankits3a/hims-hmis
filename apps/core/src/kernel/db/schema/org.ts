import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { opdDepartments } from "./opd";

/**
 * PHASE R (R1) — **THE HOSPITAL'S DEPARTMENTS, ALL OF THEM.**
 *
 * ═══ WHY A SECOND DEPARTMENT TABLE, BESIDE `opd_departments` AND NEVER INSTEAD OF IT ═══
 *
 * `opd_departments` is the twelve places a patient can be given an OPD token in (`MED`…`PHY`,
 * `modules/opd/config.ts`). It is a *counter's* list and it is correct as one. But the roster's
 * population is the whole staff of a teaching hospital, and the stress test's S3 finding is that
 * this list cannot carry them: **the CRMI intern year posts to Community Medicine, Anaesthesia,
 * Casualty and Forensic Medicine, and none of those four is a row a patient can be given a token
 * for.** Neither is Pathology, Microbiology, Biochemistry, Nursing, Pharmacy or Administration —
 * and every one of them rosters people, holds a duty at 02:00, and owes an NMC return.
 *
 * So `org_departments` is the ORGANISATIONAL list and `opd_departments` stays the CLINIC list.
 * Where a department is both, `opd_department_id` links them, `UNIQUE` so the link is a bijection
 * on the rows that have one. **`opd_departments` is not altered by this phase** (plan §5, frozen):
 * an existing counter, an existing token series and an existing fee anchor all key on those ids,
 * and a column added to them would be a migration in every lane for a fact that belongs here.
 *
 * ═══ CREATING AN OPD DEPARTMENT DOES NOT CREATE AN ORG ONE ═══
 *
 * Deliberately. An auto-create would put an unclassified, unstaffed row into the list the roster
 * validator counts against, at a moment (an admin adding a clinic) when nobody is thinking about
 * duty. The link is instead a `standup:check` finding — the census asks the question where
 * somebody is already answering questions about go-live.
 *
 * ═══ VALIDITY IS DATED, NOT DELETED ═══
 *
 * A department that closes keeps its rows: last year's roster, last year's duty, last year's
 * inspection return all name it. `valid_to` closes it; `active` is the switch a screen offers.
 */

/**
 * NMC's own division, because it is the division the returns are filed in: `clinical` teaches at
 * the bedside and admits; `para_clinical` is Pathology, Microbiology, Biochemistry, Community
 * Medicine and Forensic Medicine (and Radiodiagnosis, which reports rather than admits);
 * `nursing`, `support` and `admin` are the rest of the payroll.
 */
export const ORG_DEPARTMENT_KINDS = ["clinical", "para_clinical", "support", "nursing", "admin"] as const;
export type OrgDepartmentKind = (typeof ORG_DEPARTMENT_KINDS)[number];

const auditColumns = {
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const orgDepartments = pgTable(
  "org_departments",
  {
    id: text("id").primaryKey(),
    /** `MED`, `ANAE`, `FMT` — the code a human says out loud and an inspection return prints. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    /** Does this department take patients onto beds under its own name? Casualty does; Pathology does not. */
    admitting: boolean("admitting").notNull().default(false),
    /**
     * The clinic this department runs, when it runs one. NULL for the eleven that never will
     * (Nursing, Administration, Forensic Medicine…). UNIQUE, so two org departments can never
     * claim one clinic — which is what would make "whose OPD is this?" unanswerable.
     */
    opdDepartmentId: text("opd_department_id").references(() => opdDepartments.id),
    active: boolean("active").notNull().default(true),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    siteId: text("site_id").notNull().default("main"), // `events.site_id` / `resources.site_id`, DD3
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("org_departments_code_ux").on(t.siteId, t.code),
    uniqueIndex("org_departments_opd_department_ux").on(t.opdDepartmentId),
    check("org_departments_kind_ck", sql`${t.kind} in ('clinical', 'para_clinical', 'support', 'nursing', 'admin')`),
    check("org_departments_validity_ck", sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`),
  ],
);
