import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import {
  OT_IMPLANT_SERVICE_CODE, mkOtPatient, mkOtUser, otPatientCard, seedOtBase, testOtConfig,
} from "../../../test/helpers/ot";
import { withTx } from "../../kernel/db/client";
import {
  daycareEncounters, events, otCaseImplants, otCases, otChecklistRuns, otIncidents, resources,
} from "../../kernel/db/schema";
import { recordReceipt } from "../billing";
import { bookCase, caseState } from "./booking";
import { holdDeposit } from "./deposit";
import { caseGates, satisfyGate } from "./gates";
import { publishList } from "./lists";
import {
  backfillCase, completeChecklist, markClosure, markIncision, recordDeathOnTable,
  recordProcedureConverted, signIn, signOut, timeOut, toHolding, verifyHolding, wheelOut,
} from "./cockpit";
import { recordCount } from "./counts";
import { deployImplant, explantImplant } from "./implants";
import { createSpecimen, dispatchSpecimen } from "./specimens";
import { handleMaterialConsumed } from "./consumers";
import { OtError } from "./errors";
import type { OtBaseFixture } from "../../../test/helpers/ot";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T5 / DD7 + DD8 + DD9 — the cockpit.
 */
const LIST_DATE = "2026-09-02";
const SLOT = "2026-09-02T03:30:00.000Z"; // 09:00 IST

jest.setTimeout(40_000);

describe("the OT cockpit (Plan 15 T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let f: OtBaseFixture;
  let patientId: string;
  let cashier: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    f = await seedOtBase(db);
    patientId = await mkOtPatient(db, f.coordinator, "Sunita Devi", { phone: "9800001111" });
    cashier = await mkOtUser(db, "ot_cashier_c", ["cashier"]);
    await openSessionFor(db, { id: cashier.id }, 0);
  });

  /** Books a D&C and drives every gate to satisfied, so the case is `ready`. */
  async function readyCase(): Promise<{ caseId: string; encounterId: string }> {
    const r = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      listDate: LIST_DATE, payerClass: "self_pay",
    });
    const g = new Map((await caseGates(db, r.caseId)).map((x) => [x.kind, x.id]));
    const consent = {
      procedureCode: "GYN-DNC-01", templateVersion: "v3", language: "hi", signer: "patient",
      thumbImpression: false, laterality: null, conversionCovered: true, signedAt: "2026-09-01T10:00:00.000Z",
    };
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("consent_procedure")!, consent));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("consent_anaesthesia")!, consent));
    await withTx(db, (tx) => satisfyGate(tx, f.anaesthetist, g.get("anaesthesia_review")!, {
      asaGrade: 1, reviewedBy: f.anaesthetist.id, reviewedAt: "2026-08-30T06:00:00.000Z",
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("npo")!, {
      plannedStart: SLOT, lastSolidsAt: "2026-09-01T16:00:00.000Z",
      lastClearFluidsAt: "2026-09-01T21:00:00.000Z", attestedBy: "patient",
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("escort")!, {
      name: "Ram Kumar", relation: "husband", phone: "9800002222", idType: "aadhaar", idLast4: "4321", ageYears: 40,
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("privilege")!, {}));
    const { receiptId } = await recordReceipt(db, cashier, {
      patientId, tenders: [{ mode: "upi", amountPaise: 6_000_000, refText: "UPI/1" }],
    });
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: r.encounterId, receiptId, amountPaise: 6_000_000 }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("deposit")!, {}));
    await publishList(db, f.incharge, { listDate: LIST_DATE, theatreResourceId: f.theatreId });
    return { caseId: r.caseId, encounterId: r.encounterId };
  }

  const TIMEOUT_ITEMS = [{ key: "patient_confirmed", answer: "yes" }, { key: "site_confirmed", answer: "yes" }];

  async function toTimedOut(caseId: string): Promise<void> {
    await toHolding(db, f.incharge, caseId);
    await signIn(db, f.anaesthetist, caseId);
    await completeChecklist(db, f.otNurse, {
      caseId, phase: "timeout", items: TIMEOUT_ITEMS, participants: [f.surgeon.id, f.anaesthetist.id, f.otNurse.id],
    });
    await timeOut(db, f.otNurse, caseId);
  }

  // ═══════════════════════════════ A1/A2 — holding verification ═══════════════════════════════

  it("A1 — a wristband that scans to a DIFFERENT patient writes a near-miss and does not check the case in", async () => {
    const { caseId, encounterId } = await readyCase();
    const other = await mkOtPatient(db, f.coordinator, "Sunita Devi", { phone: "9800009999" });
    const wrongCard = await otPatientCard(db, other);

    const result = await verifyHolding(db, testOtConfig(), f.otNurse, caseId, wrongCard);
    expect(result).toEqual({ ok: false, reason: "wrong_patient" });

    const incidents = await db.select().from(otIncidents);
    expect(incidents.map((i) => i.kind)).toEqual(["identity_mismatch"]);
    expect(incidents[0]!.detail).toMatchObject({ reason: "wrong_patient", expectedPatientId: patientId });
    // The encounter is NOT checked in — the case stays exactly where it was.
    const enc = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, encounterId)))[0]!;
    expect({ checkedInAt: enc.checkedInAt, status: enc.status }).toEqual({ checkedInAt: null, status: "booked" });
    expect((await db.select().from(events)).filter((e) => e.name === "incident.reported")).toHaveLength(1);
  });

  it("A1 — the RIGHT wristband checks the encounter in, once", async () => {
    const { caseId, encounterId } = await readyCase();
    const card = await otPatientCard(db, patientId);
    expect(await verifyHolding(db, testOtConfig(), f.otNurse, caseId, card)).toEqual({ ok: true });
    const enc = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, encounterId)))[0]!;
    expect(enc.status).toBe("checked_in");
    expect(enc.checkedInAt).not.toBeNull();
    const first = enc.checkedInAt!;
    // A second scan does not re-check-in: `daycare.checked_in` is one fact.
    await verifyHolding(db, testOtConfig(), f.otNurse, caseId, card);
    const again = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, encounterId)))[0]!;
    expect(again.checkedInAt!.toISOString()).toBe(first.toISOString());
    expect((await db.select().from(events)).filter((e) => e.name === "daycare.checked_in")).toHaveLength(1);
  });

  it("a malformed card is a near-miss too, with the QR verifier's own reason", async () => {
    const { caseId } = await readyCase();
    const result = await verifyHolding(db, testOtConfig(), f.otNurse, caseId, "not-a-card");
    expect(result.ok).toBe(false);
    expect((await db.select().from(otIncidents))[0]!.detail).toMatchObject({ reason: "malformed" });
  });

  // ═══════════════════════════════ the state guards ═══════════════════════════════

  it("a case that is not `ready` cannot enter the holding bay", async () => {
    const r = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id, listDate: LIST_DATE, payerClass: "self_pay",
    });
    await expect(toHolding(db, f.incharge, r.caseId)).rejects.toThrow(/cannot enter the holding bay/);
  });

  it("F18 — sign-in by somebody who is neither the assigned anaesthetist nor an anaesthetist is refused", async () => {
    const { caseId } = await readyCase();
    await toHolding(db, f.incharge, caseId);
    await expect(signIn(db, f.otNurse, caseId)).rejects.toThrow(/neither the assigned anaesthetist nor a holder/);
  });

  it("F18 — a SUBSTITUTE anaesthetist may sign in, and the substitution is recorded", async () => {
    const { caseId } = await readyCase();
    const locum = await mkOtUser(db, "ot_locum_anaes", ["anaesthetist"]);
    await toHolding(db, f.incharge, caseId);
    await signIn(db, locum, caseId);
    const emitted = (await db.select().from(events)).filter((e) => e.name === "anaesthetist.substituted");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({ plannedAnaesthetistId: f.anaesthetist.id, actualAnaesthetistId: locum.id });
  });

  // ═══════════════════════════════ A12 (single-threaded half) ═══════════════════════════════

  it("A12 — sign-in assigns the THEATRE, and wheel-out releases it into TURNOVER", async () => {
    const { caseId } = await readyCase();
    await toHolding(db, f.incharge, caseId);
    await signIn(db, f.anaesthetist, caseId);
    const busy = (await db.select().from(resources).where(eq(resources.id, f.theatreId)))[0]!;
    expect({ status: busy.status, occupantType: busy.occupantType, occupantRef: busy.occupantRef })
      .toEqual({ status: "in_use", occupantType: "ot_case", occupantRef: caseId });

    await completeChecklist(db, f.otNurse, {
      caseId, phase: "timeout", items: TIMEOUT_ITEMS, participants: [f.surgeon.id, f.anaesthetist.id],
    });
    await timeOut(db, f.otNurse, caseId);
    await markIncision(db, f.surgeon, caseId);
    await markClosure(db, f.surgeon, caseId);
    await recordCount(db, f.otNurse, {
      caseId, round: "final", itemType: "swab", expected: 10, counted: 10,
      scrubBy: f.otNurse.id, circulatingBy: f.recoveryNurse.id,
    });
    await completeChecklist(db, f.otNurse, {
      caseId, phase: "signout", items: [{ key: "specimen_labelled", answer: "yes" }], participants: [f.otNurse.id],
    });
    await signOut(db, f.otNurse, caseId);
    await wheelOut(db, f.otNurse, caseId);

    // TURNOVER, not available — a theatre still holding the last case's instruments is not free.
    const after = (await db.select().from(resources).where(eq(resources.id, f.theatreId)))[0]!;
    expect({ status: after.status, occupantRef: after.occupantRef })
      .toEqual({ status: "turnover", occupantRef: null });
    expect(await caseState(db, caseId)).toBe("in_recovery");
  });

  // ═══════════════════════════════ A13 ═══════════════════════════════

  /**
   * ═══ A13 — TWO DISTINCT PARTICIPANTS, AND ONE ID LISTED TWICE IS THE DISCRIMINATING INPUT ═══
   *
   * A length check passes `[nurse, nurse]`; a `Set` does not. A time-out is a moment when the team
   * stops and speaks, and one person saying it to themselves is precisely what the WHO checklist
   * exists to prevent.
   */
  it("A13 — a time-out with ONE id listed twice is refused; two distinct ids pass", async () => {
    const { caseId } = await readyCase();
    await toHolding(db, f.incharge, caseId);
    await signIn(db, f.anaesthetist, caseId);
    await expect(completeChecklist(db, f.otNurse, {
      caseId, phase: "timeout", items: TIMEOUT_ITEMS, participants: [f.otNurse.id, f.otNurse.id],
    })).rejects.toThrow(/at least two DISTINCT participants; 2 were listed and 1 are different people/);
    // …and the transition is refused too, because no completed run exists.
    await expect(timeOut(db, f.otNurse, caseId)).rejects.toThrow(/time-out has not been completed/);

    await completeChecklist(db, f.otNurse, {
      caseId, phase: "timeout", items: TIMEOUT_ITEMS, participants: [f.surgeon.id, f.anaesthetist.id],
    });
    await timeOut(db, f.otNurse, caseId);
    expect(await caseState(db, caseId)).toBe("timed_out");
  });

  it("A13 — a HALTED time-out writes a near-miss and leaves the case `signed_in`", async () => {
    const { caseId } = await readyCase();
    await toHolding(db, f.incharge, caseId);
    await signIn(db, f.anaesthetist, caseId);
    const run = await completeChecklist(db, f.otNurse, {
      caseId, phase: "timeout", items: TIMEOUT_ITEMS,
      participants: [f.surgeon.id, f.anaesthetist.id],
      halt: { reason: "the consent names the left side and the marking is on the right" },
    });
    expect(run.halted).toBe(true);
    expect(await caseState(db, caseId)).toBe("signed_in");
    expect((await db.select().from(otIncidents)).map((i) => i.kind)).toEqual(["timeout_halted"]);
    expect((await db.select().from(events)).filter((e) => e.name === "timeout.halted")).toHaveLength(1);
    // A halted run is not a completed one: the transition is still refused.
    await expect(timeOut(db, f.otNurse, caseId)).rejects.toThrow(/has not been completed/);
  });

  // ═══════════════════════════════ A14 ═══════════════════════════════

  /**
   * ═══ A14 — SIGN-OUT READS THE `final` ROUND, AND `initial` IS THE COINCIDING FIXTURE ═══
   *
   * Initial 10/10, final 10/9. The mutant reads `initial` — the round that is ALWAYS correct,
   * because it is taken before anything has been used — and signs out over a retained swab. Equal
   * counts on every round is the fixture §2.102 warns about and it is deliberately not used here.
   */
  it("A14 — initial 10/10 and final 10/9 refuses sign-out and opens a count_mismatch", async () => {
    const { caseId } = await readyCase();
    await toTimedOut(caseId);
    await markIncision(db, f.surgeon, caseId);
    await markClosure(db, f.surgeon, caseId);

    await recordCount(db, f.otNurse, {
      caseId, round: "initial", itemType: "swab", expected: 10, counted: 10,
      scrubBy: f.otNurse.id, circulatingBy: f.recoveryNurse.id,
    });
    await recordCount(db, f.otNurse, {
      caseId, round: "final", itemType: "swab", expected: 10, counted: 9,
      scrubBy: f.otNurse.id, circulatingBy: f.recoveryNurse.id,
    });
    await completeChecklist(db, f.otNurse, {
      caseId, phase: "signout", items: [], participants: [f.otNurse.id],
    });

    await expect(signOut(db, f.otNurse, caseId)).rejects.toThrow(/final counts disagree: swab 10\/9/);
    expect(await caseState(db, caseId)).toBe("closing");
    expect((await db.select().from(otIncidents)).map((i) => i.kind)).toEqual(["count_mismatch"]);
    const mismatchEvents = (await db.select().from(events)).filter((e) => e.name === "count.mismatch");
    expect(mismatchEvents).toHaveLength(1);
    expect(mismatchEvents[0]!.payload).toMatchObject({ round: "final", itemType: "swab", expected: 10, counted: 9 });

    // A corrected recount — a new VERSION, both actors again — clears it.
    await recordCount(db, f.otNurse, {
      caseId, round: "final", itemType: "swab", expected: 10, counted: 10,
      scrubBy: f.otNurse.id, circulatingBy: f.recoveryNurse.id, version: 1,
    });
    await signOut(db, f.otNurse, caseId);
    expect(await caseState(db, caseId)).toBe("signed_out");
  });

  it("A14 — NO final round at all is not agreement either (H8's vacuity)", async () => {
    const { caseId } = await readyCase();
    await toTimedOut(caseId);
    await markIncision(db, f.surgeon, caseId);
    await markClosure(db, f.surgeon, caseId);
    await recordCount(db, f.otNurse, {
      caseId, round: "initial", itemType: "swab", expected: 10, counted: 10,
      scrubBy: f.otNurse.id, circulatingBy: f.recoveryNurse.id,
    });
    await completeChecklist(db, f.otNurse, { caseId, phase: "signout", items: [], participants: [f.otNurse.id] });
    await expect(signOut(db, f.otNurse, caseId)).rejects.toThrow(/no FINAL count round has been recorded/);
  });

  it("F11 — one nurse cannot be both scrub and circulating: the SoD engine blocks and EVENTS it", async () => {
    const { caseId } = await readyCase();
    await toTimedOut(caseId);
    await expect(recordCount(db, f.otNurse, {
      caseId, round: "final", itemType: "swab", expected: 10, counted: 10,
      scrubBy: f.otNurse.id, circulatingBy: f.otNurse.id,
    })).rejects.toThrow(/segregation-of-duties/);
    const blocked = (await db.select().from(events)).filter((e) => e.name === "sod.violation_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.payload).toMatchObject({ pairKey: "scrub_circulating" });
  });

  it("B4 — a stale count version is a 409, never a merge", async () => {
    const { caseId } = await readyCase();
    await toTimedOut(caseId);
    const first = await recordCount(db, f.otNurse, {
      caseId, round: "final", itemType: "swab", expected: 10, counted: 10,
      scrubBy: f.otNurse.id, circulatingBy: f.recoveryNurse.id,
    });
    expect(first.version).toBe(1);
    // A second nurse who read version 1, wrote, and is now writing again against 1.
    await recordCount(db, f.otNurse, {
      caseId, round: "final", itemType: "swab", expected: 10, counted: 9,
      scrubBy: f.otNurse.id, circulatingBy: f.recoveryNurse.id, version: 1,
    });
    await expect(recordCount(db, f.otNurse, {
      caseId, round: "final", itemType: "swab", expected: 10, counted: 8,
      scrubBy: f.otNurse.id, circulatingBy: f.recoveryNurse.id, version: 1,
    })).rejects.toThrow(/re-read it/);
    // Writing with NO version against an existing row is stale too — that is a first-write payload
    // arriving second, which is exactly what two tabs produce.
    await expect(recordCount(db, f.otNurse, {
      caseId, round: "final", itemType: "swab", expected: 10, counted: 7,
      scrubBy: f.otNurse.id, circulatingBy: f.recoveryNurse.id,
    })).rejects.toThrow(/re-read it/);
  });

  // ═══════════════════════════════ A15 ═══════════════════════════════

  /**
   * ═══ A15 — THE FIVE TIMESTAMPS, AND THE TRIGGER IS THE PROOF ═══
   *
   * `schema/ot.test.ts` already proves the DATABASE refuses a second write. This leg proves the
   * SERVICE cannot be made to try: a second `markIncision` is refused by the state machine, and no
   * function in this module takes a timestamp as input at all. Both halves are needed — a state
   * guard alone is defeated by a correction screen, and a trigger alone says nothing about whether
   * the normal path is sane.
   */
  it("A15 — a second `markIncision` is refused, and the instant is the server's", async () => {
    const { caseId } = await readyCase();
    await toTimedOut(caseId);
    const { incision } = await markIncision(db, f.surgeon, caseId);
    await expect(markIncision(db, f.surgeon, caseId)).rejects.toThrow(/cannot start/);
    const row = (await db.select().from(otCases).where(eq(otCases.id, caseId)))[0]!;
    expect(row.incision!.toISOString()).toBe(incision.toISOString());
    // …and all five are set only by their own transition: `wheel_out` is still null mid-case.
    expect({ wheelIn: row.wheelIn !== null, induction: row.induction !== null, closure: row.closure, wheelOut: row.wheelOut })
      .toEqual({ wheelIn: true, induction: true, closure: null, wheelOut: null });
  });

  it("A15 — `incision` cannot be reached without `timed_out` (B8's matrix)", async () => {
    const { caseId } = await readyCase();
    await toHolding(db, f.incharge, caseId);
    await signIn(db, f.anaesthetist, caseId);
    await expect(markIncision(db, f.surgeon, caseId)).rejects.toThrow(/the time-out comes first/);
  });

  // ═══════════════════════════════ A16 / A17 / A18 ═══════════════════════════════

  const IMPLANT = {
    itemId: "it-plate-1", batchId: "b-plate-1", lotId: "lot-plate-1", storeResourceId: "",
    serviceCode: OT_IMPLANT_SERVICE_CODE, qtyBase: 1,
  };

  it("A16 — a deployment in `signed_in` is refused `implant_state`; in `incision` it writes the row AND the event", async () => {
    const { caseId } = await readyCase();
    await toHolding(db, f.incharge, caseId);
    await signIn(db, f.anaesthetist, caseId);
    await expect(withTx(db, (tx) => deployImplant(tx, f.otNurse, {
      ...IMPLANT, storeResourceId: f.consignmentStoreId, caseId, serial: "SN-1",
    }))).rejects.toThrow(/cannot take an implant/);
    expect(await db.select().from(otCaseImplants)).toHaveLength(0);
    expect((await db.select().from(events)).filter((e) => e.name === "consignment.deployed")).toHaveLength(0);

    await completeChecklist(db, f.otNurse, {
      caseId, phase: "timeout", items: TIMEOUT_ITEMS, participants: [f.surgeon.id, f.anaesthetist.id],
    });
    await timeOut(db, f.otNurse, caseId);
    await markIncision(db, f.surgeon, caseId);
    await withTx(db, (tx) => deployImplant(tx, f.otNurse, {
      ...IMPLANT, storeResourceId: f.consignmentStoreId, caseId, serial: "SN-1", stickerRef: "STK-1",
    }));

    const rows = await db.select().from(otCaseImplants);
    expect(rows).toHaveLength(1);
    expect({ state: rows[0]!.state, source: rows[0]!.source }).toEqual({ state: "deploying", source: "consignment" });
    const deployed = (await db.select().from(events)).filter((e) => e.name === "consignment.deployed");
    expect(deployed).toHaveLength(1);
    expect(deployed[0]!.payload).toMatchObject({
      caseRef: { type: "ot_case", id: caseId }, encounterId: rows[0]!.encounterId, qtyBase: 1, stickerRef: "STK-1",
    });
  });

  /**
   * ═══ A16's SECOND HALF — A THROWN INSERT LEAVES NO EVENT ═══
   *
   * The duplicate serial makes the SECOND call fail at the unique index. Both writes are in ONE
   * transaction, so the rollback takes the event with it: exactly ONE `consignment.deployed` exists
   * afterwards. The mutant appends the event after the insert COMMITS, and leaves two.
   */
  it("A16/A17 — a duplicate serial is refused BEFORE any event, leaving one row and one event", async () => {
    const { caseId } = await readyCase();
    await toTimedOut(caseId);
    await markIncision(db, f.surgeon, caseId);
    await withTx(db, (tx) => deployImplant(tx, f.otNurse, {
      ...IMPLANT, storeResourceId: f.consignmentStoreId, caseId, serial: "SN-1",
    }));
    await expect(withTx(db, (tx) => deployImplant(tx, f.otNurse, {
      ...IMPLANT, storeResourceId: f.consignmentStoreId, caseId, serial: "SN-1",
    }))).rejects.toThrow(/already recorded on the case/);

    expect(await db.select().from(otCaseImplants)).toHaveLength(1);
    expect((await db.select().from(events)).filter((e) => e.name === "consignment.deployed")).toHaveLength(1);
  });

  /**
   * ═══ A18 — SIGN-OUT WAITS FOR THE LEDGER FACT ═══
   *
   * Deploy, do NOT run the consumer, sign out. The mutant gates on `explanted_at IS NULL`, which is
   * a different question, and signs the case out while the stores ledger does not know the plate
   * left the shelf.
   */
  it("A18 — `signOut` is refused while an implant is still `deploying`, and passes once confirmed", async () => {
    const { caseId } = await readyCase();
    await toTimedOut(caseId);
    await markIncision(db, f.surgeon, caseId);
    await withTx(db, (tx) => deployImplant(tx, f.otNurse, {
      ...IMPLANT, storeResourceId: f.consignmentStoreId, caseId, serial: "SN-1",
    }));
    await markClosure(db, f.surgeon, caseId);
    await recordCount(db, f.otNurse, {
      caseId, round: "final", itemType: "swab", expected: 10, counted: 10,
      scrubBy: f.otNurse.id, circulatingBy: f.recoveryNurse.id,
    });
    await completeChecklist(db, f.otNurse, { caseId, phase: "signout", items: [], participants: [f.otNurse.id] });

    await expect(signOut(db, f.otNurse, caseId)).rejects.toThrow(/scanned but have no ledger fact yet/);

    // The consumer arrives — `material.consumed` from the stores side — and the row is confirmed.
    const implantEncounterId = (await db.select().from(otCaseImplants))[0]!.encounterId;
    const confirmed = await withTx(db, (tx) => handleMaterialConsumed(tx, "ev-consumed-1", {
      ledgerEntryId: "led-1", itemId: IMPLANT.itemId, batchId: IMPLANT.batchId, ownership: "consignment",
      vendorId: "vn1", qtyBase: 1, patientId, encounterId: implantEncounterId,
      caseRef: { type: "ot_case", id: caseId },
      mrpPaise: 4_200_000, mrpUom: "each", mrpPaisePerBase: 4_200_000, ceilingPaisePerBase: 4_500_000,
      occurredAt: "2026-09-02T05:00:00.000Z",
    }));
    expect(confirmed.handled).toBe(true);
    const row = (await db.select().from(otCaseImplants))[0]!;
    expect({ state: row.state, ledger: row.ledgerEntryId }).toEqual({ state: "confirmed", ledger: "led-1" });

    await signOut(db, f.otNurse, caseId);
    expect(await caseState(db, caseId)).toBe("signed_out");
  });

  it("F24c — a PATIENT-SUPPLIED implant emits nothing and never blocks sign-out", async () => {
    const { caseId } = await readyCase();
    await toTimedOut(caseId);
    await markIncision(db, f.surgeon, caseId);
    await withTx(db, (tx) => deployImplant(tx, f.otNurse, {
      caseId, itemId: "it-outside-1", serviceCode: OT_IMPLANT_SERVICE_CODE, qtyBase: 1,
      source: "patient_supplied", serial: "SN-OUT-1",
    }));
    const row = (await db.select().from(otCaseImplants))[0]!;
    expect({ state: row.state, source: row.source, lotId: row.lotId }).toEqual({ state: "confirmed", source: "patient_supplied", lotId: null });
    expect((await db.select().from(events)).filter((e) => e.name === "consignment.deployed")).toHaveLength(0);
    // …and a patient-supplied row carrying a lot is refused outright.
    await expect(withTx(db, (tx) => deployImplant(tx, f.otNurse, {
      caseId, itemId: "it-outside-2", serviceCode: OT_IMPLANT_SERVICE_CODE, qtyBase: 1,
      source: "patient_supplied", lotId: "lot-x", serial: "SN-OUT-2",
    }))).rejects.toThrow(/has no consignment lot/);
  });

  it("F5 — an explant records the fact and emits `implant.explanted`, reversing nothing in materials", async () => {
    const { caseId } = await readyCase();
    await toTimedOut(caseId);
    await markIncision(db, f.surgeon, caseId);
    const { implantId } = await withTx(db, (tx) => deployImplant(tx, f.otNurse, {
      ...IMPLANT, storeResourceId: f.consignmentStoreId, caseId, serial: "SN-1",
    }));
    await withTx(db, (tx) => explantImplant(tx, f.surgeon, { implantId, reason: "wrong size, exchanged intra-op" }));
    const row = (await db.select().from(otCaseImplants).where(eq(otCaseImplants.id, implantId)))[0]!;
    expect({ state: row.state, reason: row.explantReason }).toEqual({ state: "explanted", reason: "wrong size, exchanged intra-op" });
    const emitted = (await db.select().from(events)).filter((e) => e.name === "implant.explanted");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({ implantId, lotId: IMPLANT.lotId, serial: "SN-1" });
    // Nothing was written back to materials: this phase has no return writer (F5) and does not
    // pretend to. An explanted row no longer blocks sign-out.
    await expect(withTx(db, (tx) => explantImplant(tx, f.surgeon, { implantId, reason: "again" })))
      .rejects.toThrow(/already explanted/);
  });

  // ═══════════════════════════════ specimens ═══════════════════════════════

  it("A10 — a specimen label is printed from the OPEN case only, and draws the `S` series (F17)", async () => {
    const { caseId } = await readyCase();
    await expect(withTx(db, (tx) => createSpecimen(tx, f.otNurse, {
      caseId, site: "endometrium", container: "formalin", serviceDate: LIST_DATE,
    }))).rejects.toThrow(/printed from the OPEN case/);

    await toTimedOut(caseId);
    const { specimenId, specimenNo } = await withTx(db, (tx) => createSpecimen(tx, f.otNurse, {
      caseId, site: "endometrium", container: "formalin", serviceDate: LIST_DATE,
    }));
    // `S`, the LAB's letter — not `D`, which is the encounter's.
    expect(specimenNo).toMatch(/^S\d{10}$/);

    await withTx(db, (tx) => dispatchSpecimen(tx, f.otNurse, { specimenId, destination: "in-house histopath" }));
    await expect(withTx(db, (tx) => dispatchSpecimen(tx, f.otNurse, { specimenId, destination: "again" })))
      .rejects.toThrow(/already dispatched/);
  });

  // ═══════════════════════════════ conversion, death, backfill ═══════════════════════════════

  it("G2/N11 — `procedure.converted` records whether the consent covered a conversion", async () => {
    const { caseId } = await readyCase();
    await toTimedOut(caseId);
    await markIncision(db, f.surgeon, caseId);
    const result = await recordProcedureConverted(db, f.surgeon, {
      caseId, toProcedureCode: "GYN-HYST-OP", reason: "polyp found; proceeded to operative hysteroscopy",
    });
    expect(result.consentCovered).toBe(true);
    const emitted = (await db.select().from(events)).filter((e) => e.name === "procedure.converted");
    expect(emitted[0]!.payload).toMatchObject({ fromProcedureCode: "GYN-DNC-01", toProcedureCode: "GYN-HYST-OP", consentCovered: true });
  });

  it("R-3.22 — a death on the table terminates the case, blocks the theatre and puts a legal hold on the record", async () => {
    const { caseId, encounterId } = await readyCase();
    await toTimedOut(caseId);
    await markIncision(db, f.surgeon, caseId);
    await recordDeathOnTable(db, f.surgeon, { caseId, mlcApplicable: true, note: "cardiac arrest, unresponsive to resuscitation" });

    expect(await caseState(db, caseId)).toBe("deceased");
    const theatre = (await db.select().from(resources).where(eq(resources.id, f.theatreId)))[0]!;
    expect({ status: theatre.status, reason: (theatre.attributes as { blockReason?: string }).blockReason, occupant: theatre.occupantRef })
      .toEqual({ status: "blocked", reason: "incident", occupant: null });
    const enc = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, encounterId)))[0]!;
    expect({ status: enc.status, outcome: enc.outcome, hold: enc.legalHold })
      .toEqual({ status: "deceased", outcome: "deceased", hold: true });
    expect((await db.select().from(otIncidents)).map((i) => i.kind)).toEqual(["death_on_table"]);
  });

  /**
   * C1/DD8 — the backfill walks the SAME transitions in the SAME order, so an impossible order is
   * refused by the matrix rather than by a private check that could disagree with it.
   */
  it("C1 — a downtime backfill flags every phase, with `occurred_at` before `recorded_at`", async () => {
    const { caseId } = await readyCase();
    await toHolding(db, f.incharge, caseId);
    /**
     * The paper times are relative to NOW rather than to the fixture's list date, and that is the
     * fixture obeying the code rather than the other way round: `backfillCase` refuses a phase in
     * the FUTURE, and this suite books on a list date a few days ahead of the clock the tests run
     * on. Absolute dates from the list read as future and were refused — correctly.
     */
    const t0 = Date.now() - 4 * 3_600_000;
    const paper = [
      { phase: "wheel_in" as const, occurredAt: new Date(t0) },
      { phase: "induction" as const, occurredAt: new Date(t0 + 10 * 60_000) },
      { phase: "incision" as const, occurredAt: new Date(t0 + 25 * 60_000) },
    ];
    const result = await backfillCase(db, f.incharge, { caseId, phases: paper, reason: "server down 09:00–11:00, paper record" });
    expect(result).toEqual({ state: "incision", flagged: 3 });

    const flags = (await db.select().from(events)).filter((e) => e.name === "late_entry.flagged");
    expect(flags).toHaveLength(3);
    for (const flag of flags) {
      const p = flag.payload as { occurredAt: string; recordedAt: string };
      expect(new Date(p.occurredAt).getTime()).toBeLessThan(new Date(p.recordedAt).getTime());
    }
    const row = (await db.select().from(otCases).where(eq(otCases.id, caseId)))[0]!;
    expect(row.incision!.toISOString()).toBe(new Date(t0 + 25 * 60_000).toISOString());
  });

  it("C1 — an OUT-OF-ORDER backfill is refused by the transition matrix, not by a private check", async () => {
    const { caseId } = await readyCase();
    await toHolding(db, f.incharge, caseId);
    await expect(backfillCase(db, f.incharge, {
      caseId,
      phases: [
        { phase: "incision", occurredAt: new Date(Date.now() - 3 * 3_600_000) },
        { phase: "wheel_in", occurredAt: new Date(Date.now() - 4 * 3_600_000) },
      ],
      reason: "downtime",
    })).rejects.toThrow(/no transition in_holding→incision/);
    // Nothing landed: the whole backfill is one transaction.
    expect((await db.select().from(events)).filter((e) => e.name === "late_entry.flagged")).toHaveLength(0);
  });

  it("C1 — a backfill in the FUTURE is refused, and one with no reason too", async () => {
    const { caseId } = await readyCase();
    await toHolding(db, f.incharge, caseId);
    await expect(backfillCase(db, f.incharge, {
      caseId, phases: [{ phase: "wheel_in", occurredAt: new Date(Date.now() + 3_600_000) }], reason: "x",
    })).rejects.toThrow(/cannot be in the future/);
    await expect(backfillCase(db, f.incharge, {
      caseId, phases: [{ phase: "wheel_in", occurredAt: new Date(Date.now() - 3_600_000) }], reason: "  ",
    })).rejects.toThrow(/must carry a reason/);
  });
});
