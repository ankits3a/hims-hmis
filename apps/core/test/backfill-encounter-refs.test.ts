import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser, mkPatient, seedOpdBase, seedOpdMasters, mkDoctor, activateOpdVisitDefinition } from "./helpers/opd";
import { seedBillingBase } from "./helpers/billing";
import { openVisit } from "../src/modules/opd/encounters";
import { invoices, printJobs, registrationConfig } from "../src/kernel/db/schema";
import type { Db } from "../src/kernel/db/client";
import type { BillingBaseFixture } from "./helpers/billing";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * MIGRATION 0096 — THE BACKFILL, TESTED BY RUNNING THE FILE THAT ACTUALLY SHIPS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A data migration is the one artefact a normal suite cannot reach. It runs once, against an EMPTY
 * database, before any test has inserted a row — so on every test database, every lane database and
 * every CI run, `0096` matches nothing and does nothing. A green suite says precisely zero about it,
 * which is how a backfill ships broken and is discovered on the one machine that has the data.
 *
 * So this suite reads `drizzle/0096_backfill_encounter_refs.sql` off disk and EXECUTES IT, against
 * rows shaped into the state production is in. Not a reimplementation of its logic in TypeScript —
 * that tests a copy and ships the original. The file is safe to run twice by construction (after the
 * first pass no `encounter_id` equals a `visit_no`), and the migration's own header says so.
 *
 * ═══ WHY THE FIXTURES ARE INSERTED RAW ═══
 *
 * No code path can mint these rows any more — #200's `canonicalEncounterRef` is exactly the repair
 * that stopped it. `shapeInvoiceWithLine` is the house precedent for writing a row the current
 * writer cannot produce, and this follows it. An UPDATE would not work either: `invoices` is
 * append-only (`billing_immutable`, migration 0012), which is the whole reason the migration has to
 * disable a trigger and the reason the last assertion here exists.
 */
describe("migration 0096: visits filed under a visit number are re-filed under the canonical id", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  /* `seedOpdMasters` inserts fixed department CODES, so it is once per test, not once per visit. */
  let masters: { deptId: string; roomId: string };

  const BACKFILL = join(__dirname, "..", "drizzle", "0096_backfill_encounter_refs.sql");

  /**
   * The migrator splits on `--> statement-breakpoint`; this file is one `DO` block and has none, but
   * splitting the same way it does keeps this honest if a statement is ever added.
   */
  async function runBackfill(): Promise<void> {
    const text = readFileSync(BACKFILL, "utf8");
    for (const stmt of text.split("--> statement-breakpoint")) {
      if (stmt.trim() === "") continue;
      await db.execute(sql.raw(stmt));
    }
  }

  async function aVisit(name: string, phone: string): Promise<{ patientId: string; encounterId: string; visitNo: string }> {
    const { deptId, roomId } = masters;
    const clerk = await mkUser(db, `clerk-${newId().slice(-8)}`, ["front_office"]);
    const doctor = await mkDoctor(db, { username: `dr-${newId().slice(-8)}`, departmentId: deptId, roomId, displayName: "Dr Anand Rao" });
    const patient = await mkPatient(db, clerk.actor, { name, sex: "female", ageYears: 31, phone });
    const visit = await openVisit(
      db, clerk.actor,
      { patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId },
      new Date("2026-08-17T04:00:00.000Z"),
    );
    return { patientId: patient.id, encounterId: visit.encounter.id, visitNo: visit.encounter.visitNo };
  }

  /** An invoice in the shape the pre-#200 writer left behind: the DISPLAY string in the key column. */
  async function legacyInvoice(patientId: string, encounterRef: string): Promise<string> {
    const id = newId();
    await db.insert(invoices).values({
      id,
      invoiceNo: `INV/LEGACY/${id.slice(-8)}`,
      patientId,
      encounterId: encounterRef,
      tariffVersionId: base.tariffVersionId,
      intendedPayer: "self",
      grossPaise: 50_000, discountPaise: 0, taxableBasePaise: 50_000,
      cgstPaise: 0, sgstPaise: 0, rawTotalPaise: 50_000, roundingPaise: 0, netPayablePaise: 50_000,
      issuedBy: "legacy-cashier",
      issuedAt: new Date("2026-08-17T05:00:00.000Z"),
      serviceDay: "2026-08-17",
    });
    return id;
  }

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    masters = await seedOpdMasters(db);
    base = await seedBillingBase(db);
  });

  it("re-files a bill keyed on the visit number, and leaves a correctly-keyed one exactly as it is", async () => {
    const v = await aVisit("Leela Nair", "9811100001");
    const broken = await legacyInvoice(v.patientId, v.visitNo);
    const sound = await legacyInvoice(v.patientId, v.encounterId);

    await runBackfill();

    const after = await db.select().from(invoices);
    expect(after.find((i) => i.id === broken)!.encounterId).toBe(v.encounterId);
    /* The untouched row matters as much: a backfill that rewrote every row would be indistinguishable
       from this one on the broken rows alone, and would be a different, much larger act. */
    expect(after.find((i) => i.id === sound)!.encounterId).toBe(v.encounterId);
  });

  /**
   * ═══ FD-35's RULE, APPLIED TO DATA INSTEAD OF A REQUEST ═══
   *
   * *"A GUARD, NOT A CORRECTION. The server does not get to decide which of the two the cashier
   * meant."* A row whose `patient_id` is not the visit's own patient is that disagreement frozen in
   * the ledger. Canonicalising it would ACTIVATE the link — settling one person's visit with another
   * person's bill in `feeGate`, `encounterFeeStatuses` and `daily-close` — on a decision nobody made.
   */
  it("refuses to decide: a bill whose patient is not the visit's patient is left untouched", async () => {
    const v = await aVisit("Leela Nair", "9811100002");
    const other = await aVisit("Abhay Raut", "9811100003");
    const mismatched = await legacyInvoice(other.patientId, v.visitNo);

    await runBackfill();

    const [row] = await db.select().from(invoices).where(eq(invoices.id, mismatched));
    expect(row!.encounterId).toBe(v.visitNo); // still the display string, deliberately
  });

  /**
   * The receipt job and its PAYLOAD are one fact stored twice. `subjectOf` in
   * `kernel/printing/render.ts` looks the encounter up by `opd_encounters.id` alone — it does not
   * accept a visit number the way `getEncounter` does — so a payload left behind renders NULL and
   * "save as PDF" answers *"This payment receipt is no longer available to open."*
   */
  it("re-files a print job's column AND the params its renderer reads", async () => {
    const v = await aVisit("Leela Nair", "9811100004");
    const jobId = newId();
    await db.insert(printJobs).values({
      id: jobId,
      document: "opd_payment_receipt",
      destination: "opd_counter_thermal",
      params: { encounterId: v.visitNo, amountPaise: 50_000, mode: "cash" },
      dedupeKey: `receipt:${jobId}`,
      patientId: v.patientId,
      encounterId: v.visitNo,
    });

    await runBackfill();

    const [job] = await db.select().from(printJobs).where(eq(printJobs.id, jobId));
    expect(job!.encounterId).toBe(v.encounterId);
    expect(job!.params.encounterId).toBe(v.encounterId);
  });

  /**
   * ═══ THE GUARD IS BACK ON, AND THIS IS THE ASSERTION THE WHOLE MIGRATION HANGS ON ═══
   *
   * `0096` disables `invoices_immutable` to do its work. If it ever failed to re-arm it — a missing
   * `ENABLE`, an early return, a statement reordered — production's money table would be quietly
   * mutable for ever, and NOTHING ELSE IN THIS REPOSITORY WOULD NOTICE: every other billing test
   * asserts that a write is refused through the application, which refuses it by never trying.
   *
   * The `DO` block is what makes the failure mode impossible rather than unlikely (one statement,
   * atomic, so a raise rolls the disable back too) — but "impossible by construction" is a claim,
   * and this is the measurement of it.
   */
  it("re-arms the immutability trigger it switched off — invoices are append-only again", async () => {
    const v = await aVisit("Leela Nair", "9811100005");
    const id = await legacyInvoice(v.patientId, v.visitNo);

    await runBackfill();

    await expect(
      db.update(invoices).set({ buyerLegalName: "after the backfill" }).where(eq(invoices.id, id)),
    ).rejects.toThrow(/billing_immutable/);
  });

  /** Run twice is run once. The migrator will not re-run it, but a restored drill database might. */
  it("is idempotent — a second pass matches nothing and changes nothing", async () => {
    const v = await aVisit("Leela Nair", "9811100006");
    const id = await legacyInvoice(v.patientId, v.visitNo);

    await runBackfill();
    const once = await db.select().from(invoices).where(eq(invoices.id, id));
    await runBackfill();
    const twice = await db.select().from(invoices).where(eq(invoices.id, id));

    expect(twice).toEqual(once);
    expect(twice[0]!.encounterId).toBe(v.encounterId);
  });
});
