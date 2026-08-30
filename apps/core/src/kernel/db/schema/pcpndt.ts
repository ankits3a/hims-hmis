import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { patients } from "./patients";
import { resources } from "./resources";
import { users } from "./auth";

/**
 * PLAN 18a T1 — THE PCPNDT REGISTER. Five tables, and they belong to a manifest of their OWN
 * (`pcpndt`), not to radiology (DD1).
 *
 * ═══ WHY A SEPARATE MODULE, WHICH IS THE ONE STRUCTURAL DECISION IN THIS FILE ═══
 *
 * INDEX §5 row 14 asked Plan 15 to build this and Plan 15 did not, so 18a does — and it builds it
 * where 15b (the MTP-era gynae day-care ultrasound) and 62 (maternity) can INSTALL IT WITHOUT
 * INSTALLING RADIOLOGY. The Act does not care which department held the probe: a Form F written
 * from the mini-OT's portable and one written in the radiology suite must land in ONE gap-free
 * serial series per machine per year, for one inspector reading one register. A table inside
 * `modules/radiology` would make 15b import radiology to write a statutory row.
 *
 * That is also why **`pcpndt_form_f.study_id` is `text` and NOT a foreign key into
 * `imaging_studies`** (§6.5, and it is deliberate rather than lax): 15b's scan is a day-care case,
 * not an imaging study, and an FK would name one consumer and lock the other out. The radiology
 * module enforces the link on its own side, where it knows both rows exist.
 *
 * ═══ APPEND-ONLY, WITH EXACTLY TWO EXCEPTIONS ═══
 *
 * `pcpndt_form_f` rows are frozen by trigger the moment they are written; `verified_by` and
 * `verified_at` are the only columns that may ever change, and only the PCPNDT in-charge — who by
 * separation of duties may NOT write a form — may set them. A2's *"the Part F indication is
 * editable after the inspector left"* is the defect that shape exists to make impossible.
 */

/** See `radiology.ts` for why this is transcribed rather than imported. */
function inList(column: SQL | unknown, values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[a-z][a-z0-9_]*$/.test(v)) {
      throw new Error(`inList: "${v}" is not a bare snake_case literal and cannot be inlined into DDL`);
    }
  }
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
}

/** DD14 — why the form applies to THIS scan. `indication_only` is a non-obstetric pelvic study. */
export const FORM_F_APPLICABILITIES = ["pregnant", "not_pregnant", "indication_only"] as const;

/**
 * A form is OPENED when the sonologist starts it (which mints the serial, irreversibly) and
 * RECORDED when it is complete and signed. **`assertFormFRecorded` passes only on `recorded`** —
 * T6 A3's mutant, which passes on `open`, is H8's *"Form F filled after the scan closed"* one word
 * away.
 */
export const FORM_F_STATUSES = ["open", "recorded"] as const;

export const PCPNDT_REGISTRATION_STATUSES = ["active", "suspended", "cancelled"] as const;

export type FormFApplicability = (typeof FORM_F_APPLICABILITIES)[number];
export type FormFStatus = (typeof FORM_F_STATUSES)[number];
export type PcpndtRegistrationStatus = (typeof PCPNDT_REGISTRATION_STATUSES)[number];

/**
 * ═══ 1. THE FACILITY REGISTRATION — the §19 fact, and this phase SEEDS NONE OF IT (§4A) ═══
 *
 * The registration number, its validity dates and the in-charge are LAW, not configuration: they
 * come off a certificate the hospital holds. T6 ships a runbook route and no seed, so **the module
 * refuses every applicable scan until a human enters the real registration** — which is the correct
 * behaviour of a hospital that has not filed, rather than a placeholder that lets an unregistered
 * ultrasound proceed.
 *
 * `incharge_user_id` is PLAIN TEXT holding a `users.id` — the `approvals.ts` actor-column precedent
 * (Plan 15 DD17). It is a stewardship record rather than an access-control fact: the permission
 * that lets someone verify a form is `pcpndt.form_f.verify`, held by a role, and an FK here would
 * make deactivating a leaver's account a foreign-key problem on a statutory row.
 */
export const pcpndtRegistrations = pgTable(
  "pcpndt_registrations",
  {
    id: text("id").primaryKey(),
    /** The registered PREMISES. One hospital may hold several (a satellite clinic is its own). */
    site: text("site").notNull(),
    registrationNo: text("registration_no").notNull().unique(),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    /** O-7's hard block reads this. The filed-renewal lift is 18a-ii's and needs no column change. */
    validTo: date("valid_to", { mode: "string" }).notNull(),
    inchargeUserId: text("incharge_user_id"),
    status: text("status").notNull().default("active"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pcpndt_registrations_status_idx").on(t.status, t.validTo),
    check("pcpndt_registrations_status_ck", inList(t.status, PCPNDT_REGISTRATION_STATUSES)),
    /** A validity window that ends before it begins is a typo on a legal document. */
    check("pcpndt_registrations_validity_ck", sql`${t.validTo} >= ${t.validFrom}`),
  ],
);

/**
 * ═══ 2. THE REGISTERED MACHINES — Form B's list, and the serial series is PER MACHINE ═══
 *
 * `device_resource_id` points at the registry row the radiology module scheduled against, which is
 * what makes F4's *"a non-registered machine scanned"* answerable by a join rather than by a
 * clerk's memory. `active` is a withdrawal flag rather than a delete: a machine sold last year
 * still has its serial series and its forms.
 */
export const pcpndtRegisteredMachines = pgTable(
  "pcpndt_registered_machines",
  {
    id: text("id").primaryKey(),
    registrationId: text("registration_id").notNull().references(() => pcpndtRegistrations.id),
    deviceResourceId: text("device_resource_id").notNull().references(() => resources.id),
    make: text("make").notNull(),
    model: text("model").notNull(),
    serial: text("serial").notNull(),
    /** The Form B declaration this machine was registered under. */
    formBRef: text("form_b_ref"),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * ONE ACTIVE REGISTRATION PER DEVICE. Without it a machine could sit on two registrations and
     * `activeRegistrationFor` would return whichever the planner happened to read — which is
     * §2.54's mechanism with a criminal statute on the other end of it.
     */
    uniqueIndex("pcpndt_registered_machines_device_active_ux")
      .on(t.deviceResourceId)
      .where(sql`${t.active} = true`),
    index("pcpndt_registered_machines_registration_idx").on(t.registrationId),
  ],
);

/**
 * ═══ 3. THE REGISTERED PERSONS — E1's decisive edge case, expressed as rows ═══
 *
 * N2: the 02:00 suspected ectopic, sonologist at home, ED doctor scans. **The ED doctor is a
 * registered person or the scan does not happen**, and the corporate answer is to register every
 * doctor who may ever scan (O-13's list) rather than to build a bypass. `user_id` IS a foreign key
 * here — unlike the in-charge above — because this row is the answer to "may THIS login acquire
 * THIS study", checked at `startAcquisition`, and a dangling id there is a scan attributed to
 * nobody.
 */
export const pcpndtRegisteredPersons = pgTable(
  "pcpndt_registered_persons",
  {
    id: text("id").primaryKey(),
    registrationId: text("registration_id").notNull().references(() => pcpndtRegistrations.id),
    userId: text("user_id").notNull().references(() => users.id),
    qualification: text("qualification").notNull(),
    councilRegNo: text("council_reg_no"),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * A person is registered ONCE per registration. T6 A2's third leg — *"a person registered on
     * registration A is refused on a machine of registration B"* — is a MEMBERSHIP question, and
     * membership is this row; the mutant that checks mere EXISTENCE is the one that lets a doctor
     * registered at the satellite clinic scan on the main site's machine.
     */
    uniqueIndex("pcpndt_registered_persons_registration_user_ux").on(t.registrationId, t.userId),
    index("pcpndt_registered_persons_user_idx").on(t.userId),
  ],
);

/**
 * ═══ 4. THE SERIAL COUNTER — `episode_series`'s SHAPE, and gap-free is the whole point (I6) ═══
 *
 * PER MACHINE, PER YEAR, starting at 1, with no gaps and no duplicates. The composite primary key
 * plus `nextEpisodeNo`'s upsert-and-return pattern on the CALLER's transaction is what makes twelve
 * concurrent forms mint 1..12 rather than two forms sharing a serial (T6 A1). A read-then-write
 * counter is the mutant, and it is the defect an inspector finds by counting.
 *
 * `year` rather than a date: the Act's register is a calendar-year book, and a form opened on
 * 31 December belongs to that year's book however late it is completed.
 */
export const pcpndtFormFSerials = pgTable(
  "pcpndt_form_f_serials",
  {
    machineId: text("machine_id").notNull().references(() => pcpndtRegisteredMachines.id),
    year: integer("year").notNull(),
    nextNo: bigint("next_no", { mode: "number" }).notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.machineId, t.year] })],
);

/**
 * ═══ 5. FORM F ITSELF — APPEND-ONLY, REAL NAME, ONE PER SCAN ═══
 *
 * **`patient_id` is a real FK and the reader shows `patients.name`** — J1's split, and it is the
 * one place in this phase where the alias path is deliberately NOT used. A staff nurse's own pelvic
 * ultrasound is aliased on every worklist and console in the building; her Form F carries her
 * actual name, because a statutory form with a pseudonym on it is a false declaration. `formFForStudy`
 * requires `pcpndt.form_f.read` and logs the `pcpndt.form_f` PHI surface, so the read is narrow and
 * recorded rather than open.
 *
 * **UNIQUE `(study_id)` — one form per scan.** N1's third growth scan is a THIRD study and a third
 * form with its own serial; the previous form's sections A–D are copied forward at open as a
 * convenience, never reused as a row.
 */
export const pcpndtFormF = pgTable(
  "pcpndt_form_f",
  {
    id: text("id").primaryKey(),
    /** Minted from `pcpndt_form_f_serials` on the caller's tx, gap-free per machine per year. */
    serialNo: integer("serial_no").notNull(),
    /** The calendar year the serial belongs to — carried so the register reads as a year's book. */
    serialYear: integer("serial_year").notNull(),
    machineId: text("machine_id").notNull().references(() => pcpndtRegisteredMachines.id),
    personId: text("person_id").notNull().references(() => pcpndtRegisteredPersons.id),
    /**
     * TEXT, NOT AN FK — see the file header. 15b and 62 write their own study-shaped ids here and
     * the register stays one book.
     */
    studyId: text("study_id").notNull(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    indicationCode: text("indication_code").notNull(),
    gestationWeeks: integer("gestation_weeks"),
    /** Parts A–G of the prescribed form, as written. */
    sections: jsonb("sections").notNull(),
    /** `{signature_kind: 'signature' | 'thumb', witness_name?}` — a thumb impression needs a witness. */
    declaration: jsonb("declaration").notNull(),
    /** `{slip_doc_id?, self_referral: bool, paper_serial?}` — E13's downtime backfill lands here. */
    referral: jsonb("referral").notNull(),
    applicability: text("applicability").notNull(),
    resultSummary: text("result_summary"),
    status: text("status").notNull().default("open"),
    signedBy: text("signed_by"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    /** SoD: set by a holder of `pcpndt.form_f.verify` who is NOT `signed_by` (T6 A4). */
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** I6 — the inspector's own query: no gap, no duplicate, per machine per year. */
    uniqueIndex("pcpndt_form_f_machine_serial_ux").on(t.machineId, t.serialYear, t.serialNo),
    /** N1 — one form per scan. */
    uniqueIndex("pcpndt_form_f_study_ux").on(t.studyId),
    index("pcpndt_form_f_patient_idx").on(t.patientId),
    index("pcpndt_form_f_person_idx").on(t.personId),
    check("pcpndt_form_f_applicability_ck", inList(t.applicability, FORM_F_APPLICABILITIES)),
    check("pcpndt_form_f_status_ck", inList(t.status, FORM_F_STATUSES)),
    check("pcpndt_form_f_serial_ck", sql`${t.serialNo} > 0`),
    /** A RECORDED form is signed by somebody at some instant. An open one is not yet. */
    check(
      "pcpndt_form_f_recorded_shape_ck",
      sql`${t.status} = 'open' or (${t.signedBy} is not null and ${t.signedAt} is not null)`,
    ),
    /** Verification is a person and an instant, together or not at all. */
    check(
      "pcpndt_form_f_verified_ck",
      sql`(${t.verifiedBy} is null) = (${t.verifiedAt} is null)`,
    ),
    /** Nothing unrecorded can have been verified — an inspector's counter-signature on a blank. */
    check(
      "pcpndt_form_f_verify_after_record_ck",
      sql`${t.verifiedAt} is null or ${t.status} = 'recorded'`,
    ),
  ],
);
