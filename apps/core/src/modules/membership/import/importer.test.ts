import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  counterparties, coveredMembers, events, holderBookImports, importQuarantine, membershipInstances,
  membershipPlans, patientMatchQueue, patients, registrationConfig,
} from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { registerPatient } from "../../patients";
import { MembershipError } from "../errors";
import { fixture } from "./column-maps.test";
import { importHolderBook } from "./importer";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * PLAN 09 T5 — THE HOLDER-BOOK IMPORT. CRITICAL tier: Book rows E1–E5 are each built as a mutant
 * beside this file, run isolated, and their expected-vs-received quoted in the task report.
 *
 * ═══ EVERY CODE, CARD AND PERSON IN `fixtures/` AND BELOW IS INVENTED BY THIS TASK (O-9) ═══
 * The out-of-git partner book was not read and may never be quoted into a tracked file. Each drop
 * carries one DIRT CLASS — a duplicate key, a re-sent file, an inverted validity range, an unknown
 * column shape, a transposed header, an over-cap family, a shared family phone, a fuzzy patient
 * resemblance, a mixed-script name, a dormant holder — and a class does not care which invented
 * name carries it.
 */
const operator: Actor = { type: "user", id: "import-operator-1" };
const clerk: Actor = { type: "user", id: "reg-clerk-1" };

const PARTNER_ID = "01HPARTNER0000000000T5A1";
const SOLO_PLAN_ID = "01HPLANSOLO000000000T5A1";
const FAMILY_PLAN_ID = "01HPLANFAM0000000000T5A1";
const AT = new Date("2026-09-01T06:00:00Z");

describe("holder-book import", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    await db.insert(counterparties).values({
      id: PARTNER_ID, code: "INV-CP-T5", name: "Invented selling partner",
      payeeClass: "channel_partner", createdBy: "test",
    });
    await db.insert(membershipPlans).values([
      {
        id: SOLO_PLAN_ID, code: "PL-INV-SOLO", title: "Invented single card", kind: "card",
        counterpartyId: PARTNER_ID, benefits: [], entitlements: {}, familyCap: 1,
        validityDays: 365, createdBy: "test",
      },
      {
        id: FAMILY_PLAN_ID, code: "PL-INV-FAMILY", title: "Invented family card", kind: "membership",
        counterpartyId: PARTNER_ID, benefits: [], entitlements: {}, familyCap: 3,
        validityDays: 365, createdBy: "test",
      },
    ]);
  });

  function run(file: string, version?: string): ReturnType<typeof importHolderBook> {
    return importHolderBook(db, operator, {
      counterpartyId: PARTNER_ID, fileName: file, csv: fixture(file), columnMapVersion: version,
    }, AT);
  }

  async function register(name: string, phone: string): Promise<string> {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, { name, sex: "female", phone }));
    return patient.id;
  }

  async function instances(): Promise<{ cardCode: string; partnerSaleRef: string | null; holderName: string; patientId: string | null; importRowNo: number | null; importId: string | null; origin: string; verified: boolean }[]> {
    return db
      .select({
        cardCode: membershipInstances.cardCode,
        partnerSaleRef: membershipInstances.partnerSaleRef,
        holderName: membershipInstances.holderName,
        patientId: membershipInstances.patientId,
        importRowNo: membershipInstances.importRowNo,
        importId: membershipInstances.importId,
        origin: membershipInstances.origin,
        verified: membershipInstances.verified,
      })
      .from(membershipInstances)
      .orderBy(asc(membershipInstances.seq));
  }

  // ── the baseline, and the provenance every later assertion leans on ──────────────────────────

  it("imports a clean drop, and EVERY produced row carries its import id and row number", async () => {
    const result = await run("drop-a-baseline.csv");
    expect({ accepted: result.rowsAccepted, quarantined: result.rowsQuarantined, total: result.rowsTotal })
      .toEqual({ accepted: 3, quarantined: 0, total: 3 });

    const rows = await instances();
    expect(rows.map((r) => r.cardCode)).toEqual(["KM-70", "KM-71", "KM-72"]);
    // 1-indexed and matching what a text editor shows: the header is line 1.
    expect(rows.map((r) => r.importRowNo)).toEqual([2, 3, 4]);
    expect(new Set(rows.map((r) => r.importId))).toEqual(new Set([result.importId]));
    // C-17 — a row from the partner's own book IS the verification, and it links nobody (E3).
    expect(rows.map((r) => r.origin)).toEqual(["import", "import", "import"]);
    expect(rows.map((r) => r.verified)).toEqual([true, true, true]);
    expect(rows.map((r) => r.patientId)).toEqual([null, null, null]);

    const batch = await db.select().from(holderBookImports).where(eq(holderBookImports.id, result.importId));
    expect(batch[0]).toMatchObject({
      counterpartyId: PARTNER_ID, columnMapVersion: "holder-book-v1",
      rowsTotal: 3, rowsAccepted: 3, rowsQuarantined: 0, importedBy: operator.id,
    });
  });

  it("§3.43 — the provenance invariant, SCOPED to origin='import' because grace is the other writer", async () => {
    await run("drop-a-baseline.csv");
    // The second production writer (`recognition.ts`'s O-1 grace path) inserts with no import id,
    // correctly. Shaped here directly so the scope is exercised rather than asserted in prose.
    await db.insert(membershipInstances).values({
      id: "01HGRACE00000000000T5A1X", planId: SOLO_PLAN_ID, cardCode: "ZZ-0009",
      holderName: "ZZ-0009", validFrom: AT, validTo: AT, status: "active",
      origin: "grace", verified: false,
    });
    const unprovenanced = await db
      .select({ card: membershipInstances.cardCode })
      .from(membershipInstances)
      .where(and(eq(membershipInstances.origin, "import"), isNull(membershipInstances.importId)));
    expect(unprovenanced).toEqual([]);
    // …and the leg that can fail: the grace row really is there and really has no import id.
    const grace = await db
      .select({ card: membershipInstances.cardCode })
      .from(membershipInstances)
      .where(and(eq(membershipInstances.origin, "grace"), isNull(membershipInstances.importId)));
    expect(grace).toEqual([{ card: "ZZ-0009" }]);
  });

  it("emits holder_book.imported with the counts, and no holder name or card code on the spine", async () => {
    const result = await run("drop-a-baseline.csv");
    const appended = await db.select().from(events).where(eq(events.name, "holder_book.imported"));
    expect(appended).toHaveLength(1);
    expect(appended[0]!.payload).toEqual({
      importId: result.importId, counterpartyId: PARTNER_ID, fileName: "drop-a-baseline.csv",
      columnMapVersion: "holder-book-v1", rowsTotal: 3, rowsAccepted: 3, rowsQuarantined: 0,
      rowsAlreadyApplied: 0,
    });
    expect(JSON.stringify(appended[0]!.payload)).not.toMatch(/KM-70|Vasanti/);
  });

  // ── E1: idempotency is on the SALE REFERENCE, never on the card number ───────────────────────

  it("a RE-SENT file produces zero new rows and reports that it did", async () => {
    const first = await run("drop-a-baseline.csv");
    const second = await run("drop-a-baseline.csv");
    expect({ already: second.alreadyImported, accepted: second.rowsAccepted, applied: second.rowsAlreadyApplied })
      .toEqual({ already: true, accepted: 0, applied: 3 });
    // It names the drop it recognised rather than minting a second batch.
    expect(second.importId).toBe(first.importId);
    expect(await instances()).toHaveLength(3);
    expect(await db.select().from(holderBookImports)).toHaveLength(1);
  });

  it("E1 — a REISSUED card number is a new sale, and a re-sent sale reference is not", async () => {
    await run("drop-a-baseline.csv");
    const second = await run("drop-b-reissue.csv");

    // S-1002 came in drop A and is recognised; S-1044 reissues drop A's KM-70 to another person.
    expect({ accepted: second.rowsAccepted, applied: second.rowsAlreadyApplied, quarantined: second.rowsQuarantined })
      .toEqual({ accepted: 1, applied: 1, quarantined: 0 });

    const rows = await instances();
    expect(rows).toHaveLength(4);
    const km70 = rows.filter((r) => r.cardCode === "KM-70");
    // BOTH holders of KM-70 exist: the card number repeats across drops and is not a key.
    expect(km70.map((r) => ({ ref: r.partnerSaleRef, holder: r.holderName }))).toEqual([
      { ref: "S-1001", holder: "Vasanti Kher" },
      { ref: "S-1044", holder: "Devidas Karkera" },
    ]);
  });

  // ── E2: an in-drop duplicate quarantines BOTH rows, never last-wins ──────────────────────────

  it("E2 — two rows sharing a CARD in one drop quarantine BOTH, with the reason, and neither wins", async () => {
    const result = await run("drop-duplicate-card.csv");
    expect({ accepted: result.rowsAccepted, quarantined: result.rowsQuarantined }).toEqual({ accepted: 1, quarantined: 2 });

    const rows = await instances();
    // The ONLY instance is the third row — neither claimant of QR-410 was applied.
    expect(rows.map((r) => r.cardCode)).toEqual(["QR-411"]);

    const quarantined = await db
      .select({ rowNo: importQuarantine.rowNo, reason: importQuarantine.reason, raw: importQuarantine.raw })
      .from(importQuarantine)
      .orderBy(asc(importQuarantine.rowNo));
    expect(quarantined.map((q) => ({ rowNo: q.rowNo, reason: q.reason }))).toEqual([
      { rowNo: 2, reason: "duplicate_key" },
      { rowNo: 3, reason: "duplicate_key" },
    ]);
    // The row is kept VERBATIM — what the partner sent, not what the parser made of it.
    expect(quarantined[0]!.raw).toEqual({
      line: "S-2001,QR-410,PL-INV-SOLO,Purnima Dhurve,9820100201,2026-01-01,2026-12-31,",
    });
  });

  it("two rows sharing a SALE REFERENCE in one drop quarantine both as well", async () => {
    const result = await run("drop-duplicate-saleref.csv");
    expect({ accepted: result.rowsAccepted, quarantined: result.rowsQuarantined }).toEqual({ accepted: 0, quarantined: 2 });
    expect(await instances()).toEqual([]);
    const reasons = await db.select({ reason: importQuarantine.reason }).from(importQuarantine);
    expect(reasons).toEqual([{ reason: "duplicate_key" }, { reason: "duplicate_key" }]);
  });

  // ── the validity range, and the column shape ─────────────────────────────────────────────────

  it("an INVERTED validity range quarantines that row and leaves the rest of the drop alone", async () => {
    const result = await run("drop-inverted-validity.csv");
    expect(result.quarantined).toEqual([{ rowNo: 2, reason: "inverted_validity" }]);
    expect((await instances()).map((r) => r.cardCode)).toEqual(["QR-611"]);
  });

  it("E5 — an unknown column shape refuses the WHOLE file and writes nothing at all", async () => {
    await expect(run("drop-unknown-columns.csv")).rejects.toThrow(MembershipError);
    await expect(run("drop-unknown-columns.csv")).rejects.toMatchObject({ code: "import_columns_unknown" });
    // Not a partial import: no batch row, no instance, no quarantine row.
    expect(await db.select().from(holderBookImports)).toEqual([]);
    expect(await instances()).toEqual([]);
    expect(await db.select().from(importQuarantine)).toEqual([]);
  });

  it("E5 — a TRANSPOSED drop imports correctly, because every cell is read by name", async () => {
    await run("drop-transposed.csv");
    const rows = await instances();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.holderName).toBe("Rukmini Sathe");
  });

  it("a SECOND column map version reads its own shape, including O-6's activation instant", async () => {
    const result = await run("drop-v2-activation.csv");
    expect(result.columnMapVersion).toBe("holder-book-v2");
    const rows = await db
      .select({ card: membershipInstances.cardCode, activatedAt: membershipInstances.activatedAt })
      .from(membershipInstances);
    expect(rows).toEqual([{ card: "QR-960", activatedAt: new Date("2026-01-09T00:00:00.000Z") }]);
  });

  it("a drop that does NOT carry an activation column leaves activated_at null (O-6)", async () => {
    await run("drop-a-baseline.csv");
    const withActivation = await db
      .select({ card: membershipInstances.cardCode })
      .from(membershipInstances)
      .where(isNotNull(membershipInstances.activatedAt));
    expect(withActivation).toEqual([]);
  });

  // ── E3: a fuzzy match NEVER auto-links ───────────────────────────────────────────────────────

  it("E3 — a holder who fuzzy-matches a registered patient lands in the QUEUE and is NOT linked", async () => {
    const patientId = await register("Sunandaa Phatak", "9700000101");
    const result = await run("drop-fuzzy-holder.csv");
    expect(result.queued).toEqual([{ rowNo: 2, instanceId: result.instanceIds[0]!, reason: "fuzzy_match" }]);

    const rows = await instances();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.patientId).toBeNull(); // the whole of E3

    const queue = await db
      .select({ reason: patientMatchQueue.reason, state: patientMatchQueue.state, candidates: patientMatchQueue.candidates, resolved: patientMatchQueue.resolvedPatientId })
      .from(patientMatchQueue);
    expect(queue).toHaveLength(1);
    expect({ reason: queue[0]!.reason, state: queue[0]!.state, resolved: queue[0]!.resolved })
      .toEqual({ reason: "fuzzy_match", state: "open", resolved: null });
    const candidates = queue[0]!.candidates as { patientId: string; score: number; why: string }[];
    expect(candidates.map((c) => c.patientId)).toEqual([patientId]);
    expect(candidates[0]!.score).toBeGreaterThan(0.3);
    // INDEPENDENT REVIEW, MINOR 3 — the stored reason names the HOLDER (from the partner's drop)
    // and never the matched PATIENT. See `match-queue.ts` for why the patient's name is not
    // persisted; the queue screen still renders it, read through its own gated `byId` map.
    expect(candidates[0]!.why).toContain("Sunanda Phatak"); // the holder
    expect(candidates[0]!.why).not.toContain("Sunandaa Phatak"); // the patient, never persisted
  });

  it("a DORMANT holder nobody in this hospital resembles imports inert — no queue row, no link", async () => {
    await register("Sunandaa Phatak", "9700000101");
    const result = await run("drop-dormant-holder.csv");
    expect(result.queued).toEqual([]);
    expect((await instances())[0]!.patientId).toBeNull();
    expect(await db.select().from(patientMatchQueue)).toEqual([]);
  });

  it("a SHARED FAMILY PHONE imports cleanly — a phone is not an identity and not a key", async () => {
    const result = await run("drop-shared-family-phone.csv");
    expect({ accepted: result.rowsAccepted, quarantined: result.rowsQuarantined, queued: result.queued.length })
      .toEqual({ accepted: 4, quarantined: 0, queued: 0 });
    const phones = await db.select({ phone: membershipInstances.holderPhone }).from(membershipInstances);
    expect(phones).toEqual([{ phone: "9820100801" }, { phone: "9820100801" }, { phone: "9820100801" }, { phone: "9820100801" }]);
  });

  it("a MIXED-SCRIPT holder is matched across scripts, and two drops of one person are two sales", async () => {
    const patientId = await register("Kamala Borkar", "9700000202");
    await run("drop-devanagari-holder.csv");
    await run("drop-latin-same-person.csv");

    const rows = await instances();
    // Two sale references are two sales: nothing here decides they are one person. That decision
    // is the reconcile queue's, and it is a human's.
    expect(rows.map((r) => ({ card: r.cardCode, holder: r.holderName, patient: r.patientId }))).toEqual([
      { card: "QR-950", holder: "कमला बोरकर", patient: null },
      { card: "QR-951", holder: "Kamala Borkar", patient: null },
    ]);
    const queued = await db
      .select({ instanceId: patientMatchQueue.instanceId, candidates: patientMatchQueue.candidates })
      .from(patientMatchQueue)
      .orderBy(asc(patientMatchQueue.seq));
    // BOTH spellings found the same registered patient — the Devanagari one only because the
    // candidate lane folds the query the way `patients/search.ts` does.
    expect(queued).toHaveLength(2);
    for (const q of queued) {
      expect((q.candidates as { patientId: string }[]).map((c) => c.patientId)).toEqual([patientId]);
    }
  });

  // ── E4 / O-5: over-cap members are honoured to the cap, in file order, and RECORDED ──────────

  it("E4 — over-cap members are honoured TO the cap in file order and the overflow is recorded", async () => {
    const result = await run("drop-family-over-cap.csv");
    // NOT quarantined: the member paid, and the overflow is the partner's data error (O-5).
    expect({ accepted: result.rowsAccepted, quarantined: result.rowsQuarantined }).toEqual({ accepted: 1, quarantined: 0 });

    const members = await db
      .select({ no: coveredMembers.memberNo, name: coveredMembers.name, honoured: coveredMembers.honoured, sourceRowNo: coveredMembers.sourceRowNo })
      .from(coveredMembers)
      .orderBy(asc(coveredMembers.memberNo));
    // Member 1 is the holder; the drop's own list continues from 2, in the FILE's order.
    expect(members).toEqual([
      { no: 1, name: "Girish Wagle", honoured: true, sourceRowNo: 2 },
      { no: 2, name: "Sulochana Wagle", honoured: true, sourceRowNo: 2 },
      { no: 3, name: "Anagha Wagle", honoured: true, sourceRowNo: 2 },
      { no: 4, name: "Vinayak Wagle", honoured: false, sourceRowNo: 2 },
      { no: 5, name: "Kamlakar Wagle", honoured: false, sourceRowNo: 2 },
    ]);

    const overflow = await db
      .select({ capOverflow: membershipInstances.capOverflow })
      .from(membershipInstances);
    expect(overflow[0]!.capOverflow).toEqual({
      cap: 3,
      covered: 5,
      overflow: [
        { memberNo: 4, name: "Vinayak Wagle", sourceRowNo: 2 },
        { memberNo: 5, name: "Kamlakar Wagle", sourceRowNo: 2 },
      ],
    });

    // …and it is SURFACED, not merely stored.
    const queue = await db
      .select({ reason: patientMatchQueue.reason, note: patientMatchQueue.note })
      .from(patientMatchQueue);
    expect(queue).toEqual([{ reason: "cap_overflow", note: "5 covered members declared against a cap of 3" }]);
  });

  it("a plan the hospital has never been given quarantines the row rather than inventing one", async () => {
    await db.delete(membershipPlans).where(eq(membershipPlans.id, FAMILY_PLAN_ID));
    const result = await run("drop-family-over-cap.csv");
    expect(result.quarantined).toEqual([{ rowNo: 2, reason: "unknown_plan" }]);
    expect(await instances()).toEqual([]);
  });

  it("O-9 — nothing this import wrote names a patient the drop did not, and no row is linked", async () => {
    await register("Sunandaa Phatak", "9700000101");
    await run("drop-fuzzy-holder.csv");
    const linked = await db
      .select({ card: membershipInstances.cardCode })
      .from(membershipInstances)
      .where(isNotNull(membershipInstances.patientId));
    expect(linked).toEqual([]);
    const registered = await db.select({ n: patients.id }).from(patients);
    expect(registered).toHaveLength(1); // the import registered nobody
  });
});
