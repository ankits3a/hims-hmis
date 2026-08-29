import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  ANAESTHESIA_TYPE_VALUES, DAYCARE_STATUS_VALUES, IMPLANT_SOURCE_VALUES, IMPLANT_STATE_VALUES,
  OT_COUNT_ROUND_VALUES, OT_DEFINITION_KIND_VALUES, OT_GATE_KIND_VALUES, OT_INCIDENT_KIND_VALUES,
  PAYER_CLASS_VALUES, daycareEncounters, otCaseImplants, otCases, otCounts, otDefinitions,
  otDepositHolds, patients, resources,
} from "./index";
import type { Db } from "../client";

/**
 * PLAN 15 T1 — the twelve mini-OT tables, pinned by EXECUTION against the real migration.
 *
 * `materials.test.ts`'s discipline, transcribed rather than reinvented: every leg reads
 * `information_schema` / `pg_constraint` or exercises the constraint against Postgres, never
 * compares the schema file to itself. An assertion built from the drizzle objects passes for ANY
 * migration at all — including one that was generated and never applied (§2.88).
 *
 * ═══ THE FAILURE THIS FILE ALREADY CAUGHT, RECORDED BECAUSE IT IS THE REASON DD17 SAYS "READ" ═══
 *
 * The FIRST `pnpm db:generate` of `schema/ot.ts` emitted every value CHECK as
 * `CHECK ("payer_class" in ($1, $2, …))` — bind parameters, because the helper that builds the list
 * interpolated each literal as `sql\`${v}\``, which drizzle renders into DDL as a placeholder. That
 * migration would have created a `payer_class` column with a constraint enforcing nothing. It was
 * caught by READING the generated SQL before applying it, and the "the exported arrays and the
 * CHECKs Postgres holds are the same lists" leg below is the standing guard against its return.
 *
 * ═══ AND THE TRIGGER (DD8), WHICH IS THE ONE THING HERE THAT IS NOT A CONSTRAINT ═══
 *
 * `0035` carries a `BEFORE UPDATE` trigger on `ot_cases` — billing's `0012` precedent — refusing any
 * UPDATE that changes one of the five theatre timestamps once it is non-null. So I4 / A15 is a
 * property provable by running an UPDATE, rather than a grep over controller DTOs that any future
 * writer can defeat.
 */
const AUDIT = { createdBy: "t", updatedBy: "t" };

/** The twelve tables and the columns each must have, in `order by column_name asc`. */
const CENSUS: Record<string, string[]> = {
  daycare_encounters: [
    "bay_resource_id", "checked_in_at", "converted_at", "created_at", "created_by", "discharged_at",
    "encounter_no", "escort", "escort_patient_id", "handoff_document_id", "id", "legal_hold",
    "opd_encounter_id", "outcome", "patient_id", "payer_class", "re_verify_identity", "scheme_ref",
    "status", "updated_at", "updated_by",
  ],
  ot_cases: [
    "anaesthesia_type", "anaesthetist_id", "asa_grade", "cancellation_attribution",
    "cancellation_reason", "closure", "created_at", "created_by", "encounter_id", "id", "incision",
    "induction", "laterality", "list_date", "package_service_code", "patient_id", "payer_class",
    "procedure_class", "procedure_code", "quote_paise", "return_of_case_id", "seq", "surgeon_id",
    "tariff_version_id", "theatre_resource_id", "updated_at", "updated_by", "wheel_in", "wheel_out",
    "workflow_instance_id", "wound_class",
  ],
  ot_lists: [
    "created_at", "created_by", "id", "list_date", "published_at", "published_by", "status",
    "theatre_resource_id", "version",
  ],
  ot_case_gates: [
    "case_id", "created_at", "evidence", "id", "kind", "override", "satisfied_at", "satisfied_by",
    "waivable", "workflow_instance_id",
  ],
  ot_checklist_runs: [
    "case_id", "completed_at", "created_at", "halt_reason", "halted", "id", "items", "participants",
    "phase", "recorded_by",
  ],
  ot_counts: [
    "case_id", "circulating_by", "counted", "expected", "id", "item_type", "recorded_at", "round",
    "scrub_by", "version",
  ],
  ot_case_implants: [
    "batch_id", "case_id", "created_at", "deployed_at", "deployed_by", "encounter_id", "event_id",
    "explant_reason", "explanted_at", "id", "item_id", "ledger_entry_id", "lot_id", "qty_base",
    "serial", "service_code", "source", "state", "sticker_ref", "verified_by",
  ],
  ot_specimens: [
    "case_id", "container", "created_at", "created_by", "dispatch_destination", "dispatched_at",
    "dispatched_by", "encounter_id", "id", "patient_id", "received_ack", "site", "specimen_no",
  ],
  pacu_scores: [
    "bay_resource_id", "case_id", "encounter_id", "id", "occurred_at", "recorded_at", "scale",
    "scored_by", "total", "values",
  ],
  ot_definitions: [
    "approval_id", "body", "created_at", "drafted_by", "id", "kind", "published_at", "published_by",
    "status", "version",
  ],
  ot_deposit_holds: [
    "amount_paise", "encounter_id", "held_at", "held_by", "id", "paid_by", "receipt_id",
    "released_at", "released_reason",
  ],
  ot_incidents: [
    "case_id", "detail", "encounter_id", "id", "kind", "reported_at", "reported_by", "resolution",
    "resolved_at",
  ],
};

describe("the mini-OT tables (Plan 15 T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function columnsOf(table: string): Promise<string[]> {
    const rows = (await db.execute(sql`
      select column_name as "columnName" from information_schema.columns
      where table_schema = 'public' and table_name = ${table} order by column_name asc
    `)).rows as { columnName: string }[];
    return rows.map((r) => r.columnName);
  }

  async function constraintDef(name: string): Promise<string | undefined> {
    const rows = (await db.execute(sql`
      select pg_get_constraintdef(oid) as "def" from pg_constraint where conname = ${name}
    `)).rows as { def: string }[];
    return rows[0]?.def;
  }

  // ────────────────────────────── the census ──────────────────────────────

  it("all twelve tables exist with exactly the columns the plan names", async () => {
    for (const [table, expected] of Object.entries(CENSUS)) {
      expect({ table, columns: await columnsOf(table) }).toEqual({ table, columns: expected });
    }
  });

  /**
   * TWELVE, and the plan's T1 heading says "Ten tables" while its own Produces list names twelve
   * (finding T1-a). The number is asserted rather than only corrected in prose, so the next phase
   * that extends this family counts what exists.
   */
  it("there are exactly TWELVE — the plan's T1 heading said ten (finding T1-a)", () => {
    expect(Object.keys(CENSUS)).toHaveLength(12);
  });

  /**
   * DD4, asserted as an ABSENCE. `ot_cases` and `ot_case_gates` carry no status column: the state
   * of a case and of a gate is its workflow instance's `current_state`, and a mirror here would be
   * a second answer to "is this gate satisfied" that no transaction updates atomically with the
   * first. The plan's Produces list named `state` on `ot_case_gates`; it is deliberately not built
   * (finding T1-b), and this leg is what stops it being added back without an argument.
   */
  it("neither ot_cases nor ot_case_gates mirrors the workflow state (DD4, finding T1-b)", async () => {
    for (const table of ["ot_cases", "ot_case_gates"]) {
      const cols = await columnsOf(table);
      expect({ table, hasState: cols.includes("state"), hasStatus: cols.includes("status") })
        .toEqual({ table, hasState: false, hasStatus: false });
      expect(cols).toContain("workflow_instance_id");
    }
  });

  /** Plan 13 DD2 — no `active` toggle anywhere in this module, in any table. */
  it("no table in this family carries an `active` column (Plan 13 DD2)", async () => {
    const withActive: string[] = [];
    for (const table of Object.keys(CENSUS)) {
      if ((await columnsOf(table)).includes("active")) withActive.push(table);
    }
    expect(withActive).toEqual([]);
  });

  // ───────────────── the value CHECKs Postgres actually holds ─────────────────

  /**
   * THE STANDING GUARD AGAINST THE `$1` DEFECT (see the file header). Each exported array is
   * compared to the constraint's own text read back out of Postgres, in BOTH directions: every
   * value is present, and the constraint admits nothing else.
   */
  it("the exported value arrays and the CHECKs Postgres holds are the same lists", async () => {
    const cases: [string, readonly string[]][] = [
      ["daycare_encounters_payer_class_ck", PAYER_CLASS_VALUES],
      ["daycare_encounters_status_ck", DAYCARE_STATUS_VALUES],
      ["ot_case_gates_kind_ck", OT_GATE_KIND_VALUES],
      ["ot_counts_round_ck", OT_COUNT_ROUND_VALUES],
      ["ot_case_implants_source_ck", IMPLANT_SOURCE_VALUES],
      ["ot_case_implants_state_ck", IMPLANT_STATE_VALUES],
      ["ot_definitions_kind_ck", OT_DEFINITION_KIND_VALUES],
      ["ot_incidents_kind_ck", OT_INCIDENT_KIND_VALUES],
    ];
    for (const [name, values] of cases) {
      const def = await constraintDef(name);
      expect({ name, found: def !== undefined }).toEqual({ name, found: true });
      for (const v of values) {
        expect({ name, v, present: def!.includes(`'${v}'`) }).toEqual({ name, v, present: true });
      }
      // Nothing else: a CHECK carrying a tenth gate kind the union does not know fails here — and
      // so does a CHECK rendered as `in ($1, $2, …)`, which quotes no literal at all.
      expect({ name, literals: (def!.match(/'[a-z0-9_]+'::text/g) ?? []).length })
        .toEqual({ name, literals: values.length });
    }
    // The two nullable-column enums use the `is null or … in (…)` shape, so they are checked for
    // membership only; the count assertion above does not apply to them.
    const anaes = await constraintDef("ot_cases_anaesthesia_type_ck");
    for (const v of ANAESTHESIA_TYPE_VALUES) expect(anaes).toContain(`'${v}'`);
  });

  /**
   * DD5's ABSENCES, and this is the leg the whole "not stubbed, absent" ruling rests on (DD18,
   * finding F12). `mtp` and the statutory gate kinds are outside the CHECK, so a criteria
   * definition cannot widen the whitelist into 15b's territory by DATA — the row will not insert.
   */
  it("the gate-kind CHECK admits none of 15b/15c/15d's kinds (DD18, F12)", async () => {
    const def = await constraintDef("ot_case_gates_kind_ck");
    for (const absent of ["mtp", "form_f", "sterile_set", "implant_availability", "blood", "theatre_fit"]) {
      expect({ absent, present: def!.includes(`'${absent}'`) }).toEqual({ absent, present: false });
    }
  });

  // ───────────────── the same CHECKs, EXERCISED: a wrong predicate is caught here ─────────────────

  async function fixture(): Promise<{ patientId: string; theatreId: string; encounterId: string; caseId: string }> {
    await db.insert(patients).values({
      id: "p1", uhid: "U00000018", name: "Sunita Devi", sex: "female", administrativeGender: "female", ...AUDIT,
    });
    await db.insert(resources).values({
      id: "th1", kind: "theatre", code: "OT-1", name: "Theatre 1", status: "available", ...AUDIT,
    });
    await db.insert(daycareEncounters).values({
      id: "e1", encounterNo: "D2608280001", patientId: "p1", payerClass: "self_pay", ...AUDIT,
    });
    await db.insert(otCases).values({
      id: "c1", encounterId: "e1", patientId: "p1", theatreResourceId: "th1", listDate: "2026-08-28",
      seq: 1, procedureCode: "GYN-DNC", procedureClass: "gynae_minor", surgeonId: "u1",
      packageServiceCode: "SVC-DAYCARE-GYN", quotePaise: 6000000, tariffVersionId: "tv1",
      payerClass: "self_pay", workflowInstanceId: "wf1", ...AUDIT,
    });
    return { patientId: "p1", theatreId: "th1", encounterId: "e1", caseId: "c1" };
  }

  it("REFUSES a patient escorting themselves, and admits a different escort (A7)", async () => {
    await fixture();
    await expect(db.update(daycareEncounters).set({ escortPatientId: "p1" }))
      .rejects.toThrow(/daycare_encounters_escort_not_self_ck/);
    // The ordinary case — no escort UHID at all — must survive: `IS DISTINCT FROM`, not `<>`.
    await db.update(daycareEncounters).set({ escortPatientId: null });
    await db.insert(patients).values({ id: "p2", uhid: "U00000026", name: "Ram Kumar", sex: "male", administrativeGender: "male", ...AUDIT });
    await db.update(daycareEncounters).set({ escortPatientId: "p2" });
  });

  /**
   * DD7 / F11 — THE TWO-PERSON COUNT AT THE DATABASE. The service layer's SoD check compares two
   * actors at one call site; this constraint is the half that survives raw SQL and a future
   * migration, which is what makes A14's second clause a database property.
   */
  it("REFUSES a count round whose scrub and circulating nurse are the same person (DD7)", async () => {
    const f = await fixture();
    const base = { caseId: f.caseId, itemType: "swab", expected: 10, counted: 10 };
    await expect(db.insert(otCounts).values({
      id: "ct-bad", round: "final", ...base, scrubBy: "u9", circulatingBy: "u9",
    })).rejects.toThrow(/ot_counts_two_person_ck/);
    // Two different nurses insert — a constraint that refused everything would pass the leg above.
    await db.insert(otCounts).values({
      id: "ct-ok", round: "final", ...base, scrubBy: "u9", circulatingBy: "u8",
    });
    // One round per (case, item type): a "recount" is a NEW round, never an overwrite.
    await expect(db.insert(otCounts).values({
      id: "ct-dup", round: "final", ...base, scrubBy: "u7", circulatingBy: "u6",
    })).rejects.toThrow(/ot_counts_case_round_item_ux/);
  });

  /**
   * H10 / A17 — the duplicate-scan guard, exercised. It is a PARTIAL unique index, so two implants
   * with NO serial on one case are legal (a pair of screws off one strip) while two rows with the
   * same serial are not.
   */
  it("REFUSES a second implant row with the same serial on one case, and allows two serial-less rows (H10)", async () => {
    const f = await fixture();
    const base = {
      caseId: f.caseId, encounterId: f.encounterId, itemId: "it1", batchId: "b1", lotId: "lot1",
      serviceCode: "SVC-IMPLANT-PLATE", qtyBase: 1, deployedBy: "u1",
    };
    await db.insert(otCaseImplants).values({ id: "im1", ...base, serial: "SN-001" });
    await expect(db.insert(otCaseImplants).values({ id: "im2", ...base, serial: "SN-001" }))
      .rejects.toThrow(/ot_case_implants_case_serial_ux/);
    await db.insert(otCaseImplants).values({ id: "im3", ...base, serial: null });
    await db.insert(otCaseImplants).values({ id: "im4", ...base, serial: null });
  });

  /** F24c — a consignment row needs a lot; a patient-supplied one must not have one. Both ways. */
  it("REFUSES a consignment implant with no lot and a patient-supplied implant WITH one (F24c)", async () => {
    const f = await fixture();
    const base = { caseId: f.caseId, encounterId: f.encounterId, serviceCode: "SVC-X", qtyBase: 1, deployedBy: "u1" };
    await expect(db.insert(otCaseImplants).values({ id: "x1", ...base, source: "consignment", lotId: null }))
      .rejects.toThrow(/ot_case_implants_source_lot_ck/);
    await expect(db.insert(otCaseImplants).values({ id: "x2", ...base, source: "patient_supplied", lotId: "lot1" }))
      .rejects.toThrow(/ot_case_implants_source_lot_ck/);
    await db.insert(otCaseImplants).values({ id: "x3", ...base, source: "patient_supplied", lotId: null });
  });

  /** DD6 / A2 — one ACTIVE version per definition kind, as a database invariant. */
  it("REFUSES a second ACTIVE version of one definition kind, and allows many drafts (DD6)", async () => {
    const published = { publishedBy: "u1", publishedAt: new Date(), draftedBy: "u2" };
    await db.insert(otDefinitions).values({ id: "d1", kind: "criteria", version: 1, body: {}, status: "active", ...published });
    await expect(db.insert(otDefinitions).values({
      id: "d2", kind: "criteria", version: 2, body: {}, status: "active", ...published,
    })).rejects.toThrow(/ot_definitions_one_active_ux/);
    // A draft alongside the active one is the whole point of the publish flow.
    await db.insert(otDefinitions).values({ id: "d3", kind: "criteria", version: 2, body: {}, draftedBy: "u2" });
    // …and an active row must name who published it and when.
    await expect(db.insert(otDefinitions).values({
      id: "d4", kind: "privileges", version: 1, body: {}, status: "active", draftedBy: "u2",
    })).rejects.toThrow(/ot_definitions_published_ck/);
  });

  /** DD12 — a hold is a positive amount; a released hold carries its reason. */
  it("REFUSES a zero-amount hold and a release with no reason (DD12)", async () => {
    const f = await fixture();
    await expect(db.insert(otDepositHolds).values({
      id: "h0", encounterId: f.encounterId, receiptId: "r1", amountPaise: 0, heldBy: "u1",
    })).rejects.toThrow(/ot_deposit_holds_amount_ck/);
    await db.insert(otDepositHolds).values({
      id: "h1", encounterId: f.encounterId, receiptId: "r1", amountPaise: 5000000, heldBy: "u1",
    });
    await expect(db.update(otDepositHolds).set({ releasedAt: new Date() }))
      .rejects.toThrow(/ot_deposit_holds_release_ck/);
    await db.update(otDepositHolds).set({ releasedAt: new Date(), releasedReason: "case cancelled" });
  });

  // ─────────────────────── DD8: the trigger, not a grep (I4 / A15) ───────────────────────

  it("the five theatre timestamps are WRITE-ONCE — the trigger refuses a second incision (DD8)", async () => {
    const f = await fixture();
    const first = new Date("2026-08-28T04:30:00.000Z");
    const second = new Date("2026-08-28T05:30:00.000Z");

    // NULL → a value is legal: that is the transition setting it for the first time.
    await db.update(otCases).set({ incision: first });
    // A value → a DIFFERENT value is refused, whatever writes it — including this raw update, which
    // is exactly the path a "correction screen" would take.
    await expect(db.update(otCases).set({ incision: second }))
      .rejects.toThrow(/ot_timestamp_immutable/);
    // A value → NULL is refused too: erasing an incision is not a correction, it is a deletion.
    await expect(db.update(otCases).set({ incision: null }))
      .rejects.toThrow(/ot_timestamp_immutable/);
    // Writing the SAME value again is a no-op the trigger permits — a retried transaction must not
    // become a hard error, and `IS DISTINCT FROM` is what makes that true.
    await db.update(otCases).set({ incision: first });
    // Every one of the five, not just the one the plan's example names.
    for (const column of ["wheel_in", "induction", "closure", "wheel_out"] as const) {
      await db.execute(sql`update ot_cases set ${sql.identifier(column)} = ${first} where id = ${f.caseId}`);
      await expect(
        db.execute(sql`update ot_cases set ${sql.identifier(column)} = ${second} where id = ${f.caseId}`),
      ).rejects.toThrow(/ot_timestamp_immutable/);
    }
    // And an UNRELATED column still updates — a trigger that refused every UPDATE would pass every
    // leg above and make the case row read-only from the moment it is created.
    await db.update(otCases).set({ woundClass: "clean" });
    const rows = await db.select().from(otCases);
    expect({ wound: rows[0]!.woundClass, incision: rows[0]!.incision?.toISOString() })
      .toEqual({ wound: "clean", incision: first.toISOString() });
  });
});
