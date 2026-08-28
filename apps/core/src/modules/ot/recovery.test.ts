import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { mkOtPatient, mkOtUser, seedOtBase } from "../../../test/helpers/ot";
import { withTx } from "../../kernel/db/client";
import { daycareEncounters, events, otCases, pacuScores, resources } from "../../kernel/db/schema";
import { recordReceipt } from "../billing";
import { bookCase, caseState } from "./booking";
import { holdDeposit } from "./deposit";
import { caseGates, satisfyGate } from "./gates";
import { publishList } from "./lists";
import { completeChecklist, markClosure, markIncision, signIn, timeOut, toHolding, signOut, wheelOut } from "./cockpit";
import { recordCount } from "./counts";
import {
  admitToBay, convertToAdmission, dischargeDaycare, evaluateDischargeReady, istTimePassed,
  markAbsconded, readinessOf, recordScore, recoveryBoard, verifyEscort,
} from "./recovery";
import type { OtBaseFixture } from "../../../test/helpers/ot";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T6 / DD10 — recovery.
 */
const LIST_DATE = "2026-09-02";
const SLOT = "2026-09-02T03:30:00.000Z";
jest.setTimeout(40_000);

const ESCORT = {
  name: "Ram Kumar", relation: "husband", phone: "9800002222",
  idType: "aadhaar", idLast4: "4321", ageYears: 40,
};
const GOOD_SCORE = { vitals: 2, ambulation: 2, nausea: 2, pain: 2, bleeding: 2 }; // 10 >= 9
const POOR_SCORE = { vitals: 2, ambulation: 1, nausea: 1, pain: 1, bleeding: 1 }; // 6 < 9

describe("OT recovery (Plan 15 T6 / DD10)", () => {
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
    cashier = await mkOtUser(db, "ot_cashier_r", ["cashier"]);
    await openSessionFor(db, { id: cashier.id }, 0);
  });

  /** A case driven all the way to `in_recovery`, in a bay. */
  async function inRecovery(pid = patientId, phone = "9800001111"): Promise<{ caseId: string; encounterId: string }> {
    const r = await bookCase(db, f.coordinator, {
      patientId: pid, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      anaesthesiaType: "general", listDate: LIST_DATE, payerClass: "self_pay", force: true,
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
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("escort")!, ESCORT));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("privilege")!, {}));
    const { receiptId } = await recordReceipt(db, cashier, {
      patientId: pid, tenders: [{ mode: "upi", amountPaise: 6_000_000, refText: `UPI/${phone}` }],
    });
    await withTx(db, (tx) => holdDeposit(tx, f.coordinator, { encounterId: r.encounterId, receiptId, amountPaise: 6_000_000 }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, g.get("deposit")!, {}));
    await publishList(db, f.incharge, { listDate: LIST_DATE, theatreResourceId: f.theatreId });
    await toHolding(db, f.incharge, r.caseId);
    await signIn(db, f.anaesthetist, r.caseId);
    await completeChecklist(db, f.otNurse, {
      caseId: r.caseId, phase: "timeout", items: [], participants: [f.surgeon.id, f.anaesthetist.id],
    });
    await timeOut(db, f.otNurse, r.caseId);
    await markIncision(db, f.surgeon, r.caseId);
    await markClosure(db, f.surgeon, r.caseId);
    await recordCount(db, f.otNurse, {
      caseId: r.caseId, round: "final", itemType: "swab", expected: 10, counted: 10,
      scrubBy: f.otNurse.id, circulatingBy: f.recoveryNurse.id,
    });
    await completeChecklist(db, f.otNurse, { caseId: r.caseId, phase: "signout", items: [], participants: [f.otNurse.id] });
    await signOut(db, f.otNurse, r.caseId);
    await wheelOut(db, f.otNurse, r.caseId);
    return { caseId: r.caseId, encounterId: r.encounterId };
  }

  // ═══════════════════════════════ bays ═══════════════════════════════

  it("admits to a bay through the registry, and the board shows the occupant", async () => {
    const { encounterId } = await inRecovery();
    await admitToBay(db, f.recoveryNurse, { encounterId, bayResourceId: f.bayIds[0]! });
    const board = await recoveryBoard(db);
    expect(board).toHaveLength(2);
    expect(board[0]).toMatchObject({ code: "RB-1", status: "occupied", occupantType: "daycare_encounter", occupantRef: encounterId });
    expect(board[1]).toMatchObject({ code: "RB-2", status: "available", occupantRef: null });
  });

  /**
   * F23 — the refusal NAMES the occupant. "Occupied" alone sends a recovery nurse to look at two
   * identical bays; N10's ED-overflow occupant is representable and must be visible.
   */
  it("F23 — an occupied bay refuses with the CURRENT occupant named", async () => {
    const a = await inRecovery();
    const other = await mkOtPatient(db, f.coordinator, "Meena Kumari", { phone: "9800003311" });
    const b = await inRecovery(other, "9800003311");
    await admitToBay(db, f.recoveryNurse, { encounterId: a.encounterId, bayResourceId: f.bayIds[0]! });
    try {
      await admitToBay(db, f.recoveryNurse, { encounterId: b.encounterId, bayResourceId: f.bayIds[0]! });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(String(error)).toMatch(new RegExp(`bay RB-1 is occupied by daycare_encounter ${a.encounterId}`));
      expect((error as { detail?: { occupantType: string } }).detail)
        .toMatchObject({ bayCode: "RB-1", occupantType: "daycare_encounter", occupantRef: a.encounterId });
    }
    // The second bay is free and takes her.
    await admitToBay(db, f.recoveryNurse, { encounterId: b.encounterId, bayResourceId: f.bayIds[1]! });
  });

  it("refuses a resource that is not a day-care recovery bay", async () => {
    const { encounterId } = await inRecovery();
    await expect(admitToBay(db, f.recoveryNurse, { encounterId, bayResourceId: f.theatreId }))
      .rejects.toThrow(/is not a day-care recovery bay/);
  });

  // ═══════════════════════════════ A20 ═══════════════════════════════

  /**
   * ═══ A20 — TWO THRESHOLD SCORES, THIRTY MINUTES APART ═══
   *
   * Two qualifying scores TEN minutes apart → not ready. A third at +30 → ready. The mutant accepts
   * any ONE threshold score and sends a post-anaesthesia patient home ten minutes after her first
   * good observation.
   *
   * The clock is `occurred_at`, TYPED — so a nurse charting both at the end of an hour cannot
   * satisfy the rule with two rows four seconds apart (B7/F25).
   */
  it("A20 — two qualifying scores 10 min apart are NOT ready; a third at +30 is", async () => {
    const { caseId, encounterId } = await inRecovery();
    await admitToBay(db, f.recoveryNurse, { encounterId, bayResourceId: f.bayIds[0]! });
    const t0 = new Date("2026-09-02T06:00:00.000Z");

    await recordScore(db, f.recoveryNurse, { encounterId, caseId, values: GOOD_SCORE, occurredAt: t0 });
    let verdict = await evaluateDischargeReady(db, { encounterId, caseId });
    expect({ ready: verdict.ready, qualifying: verdict.qualifying }).toEqual({ ready: false, qualifying: 1 });
    expect(await caseState(db, caseId)).toBe("in_recovery");

    await recordScore(db, f.recoveryNurse, {
      encounterId, caseId, values: GOOD_SCORE, occurredAt: new Date(t0.getTime() + 10 * 60_000),
    });
    verdict = await evaluateDischargeReady(db, { encounterId, caseId });
    expect({ ready: verdict.ready, gap: verdict.gapMinutes }).toEqual({ ready: false, gap: 10 });
    expect(await caseState(db, caseId)).toBe("in_recovery");

    await recordScore(db, f.recoveryNurse, {
      encounterId, caseId, values: GOOD_SCORE, occurredAt: new Date(t0.getTime() + 40 * 60_000),
    });
    verdict = await evaluateDischargeReady(db, { encounterId, caseId });
    expect({ ready: verdict.ready, gap: verdict.gapMinutes }).toEqual({ ready: true, gap: 30 });
    expect(await caseState(db, caseId)).toBe("discharge_ready");
    const ready = (await db.select().from(events)).filter((e) => e.name === "daycare.discharge_ready");
    expect(ready).toHaveLength(1);
  });

  /**
   * The gap is measured between the LAST TWO qualifying scores, not the first and the last. A
   * patient who scored well at 10:00, badly at 10:20 and well at 10:35 has been stable for fifteen
   * minutes, not thirty-five — and a first-to-last implementation would discharge her.
   */
  it("A20 — a POOR score between two good ones resets the clock, and the pure function says so", () => {
    const t = (m: number): Date => new Date(Date.UTC(2026, 8, 2, 6, m));
    const scale = { threshold: 9, minScores: 2, minGapMinutes: 30 };
    // 10:00 good, 10:20 poor, 10:35 good — the two QUALIFYING scores are 35 minutes apart, which a
    // naive reading calls ready. They are, and that is the honest answer: the rule is about two
    // GOOD observations far enough apart, and the poor one in between is not one of them.
    expect(readinessOf([
      { total: 10, occurredAt: t(0) }, { total: 6, occurredAt: t(20) }, { total: 10, occurredAt: t(35) },
    ], scale)).toMatchObject({ ready: true, qualifying: 2, gapMinutes: 35 });
    // Three good scores: the gap is between the LAST TWO, so a long-ago first one does not carry a
    // recent pair over the line.
    expect(readinessOf([
      { total: 10, occurredAt: t(0) }, { total: 10, occurredAt: t(50) }, { total: 10, occurredAt: t(55) },
    ], scale)).toMatchObject({ ready: false, qualifying: 3, gapMinutes: 5 });
  });

  it("A20 — a score BELOW the threshold does not qualify at all", async () => {
    const { caseId, encounterId } = await inRecovery();
    await admitToBay(db, f.recoveryNurse, { encounterId, bayResourceId: f.bayIds[0]! });
    const t0 = new Date("2026-09-02T06:00:00.000Z");
    await recordScore(db, f.recoveryNurse, { encounterId, caseId, values: POOR_SCORE, occurredAt: t0 });
    await recordScore(db, f.recoveryNurse, {
      encounterId, caseId, values: POOR_SCORE, occurredAt: new Date(t0.getTime() + 60 * 60_000),
    });
    const verdict = await evaluateDischargeReady(db, { encounterId, caseId });
    expect({ ready: verdict.ready, qualifying: verdict.qualifying }).toEqual({ ready: false, qualifying: 0 });
  });

  it("F24b — the scale is the CASE's anaesthesia technique: a spinal is scored on a longer set", async () => {
    const spinalPatient = await mkOtPatient(db, f.coordinator, "Kavita Rao", { phone: "9800004411" });
    const r = await bookCase(db, f.coordinator, {
      patientId: spinalPatient, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      anaesthesiaType: "spinal", listDate: LIST_DATE, payerClass: "self_pay", force: true,
    });
    await db.update(daycareEncounters).set({ bayResourceId: f.bayIds[1]! })
      .where(eq(daycareEncounters.id, r.encounterId));
    // The GA scale's five items are not enough for a spinal — it needs voiding and motor block too.
    await expect(recordScore(db, f.recoveryNurse, {
      encounterId: r.encounterId, caseId: r.caseId, values: GOOD_SCORE,
    })).rejects.toThrow(/needs every item; missing: voiding, motor_block/);
    const ok = await recordScore(db, f.recoveryNurse, {
      encounterId: r.encounterId, caseId: r.caseId,
      values: { ...GOOD_SCORE, voiding: 2, motor_block: 2 },
    });
    expect({ scale: ok.scale, total: ok.total }).toEqual({ scale: "padss_spinal", total: 14 });
  });

  it("refuses a score for an encounter that is not in a bay (H11)", async () => {
    const { caseId, encounterId } = await inRecovery();
    await expect(recordScore(db, f.recoveryNurse, { encounterId, caseId, values: GOOD_SCORE }))
      .rejects.toThrow(/not in a recovery bay/);
  });

  // ═══════════════════════════════ A21 ═══════════════════════════════

  /**
   * ═══ A21 — A CHECK-IN VERIFICATION IS NOT A DISCHARGE VERIFICATION ═══
   *
   * The mutant reads the check-in one. Six hours separate them, and "who brought her" and "who is
   * taking her home" are different questions often enough that treating them as one is the defect
   * E-4 exists to prevent.
   */
  it("A21 — discharge is refused with only a CHECK-IN escort verification", async () => {
    const { caseId, encounterId } = await inRecovery();
    await admitToBay(db, f.recoveryNurse, { encounterId, bayResourceId: f.bayIds[0]! });
    await verifyEscort(db, f.recoveryNurse, { encounterId, at: "checkin", escort: ESCORT });
    const t0 = new Date("2026-09-02T06:00:00.000Z");
    await recordScore(db, f.recoveryNurse, { encounterId, caseId, values: GOOD_SCORE, occurredAt: t0 });
    await recordScore(db, f.recoveryNurse, { encounterId, caseId, values: GOOD_SCORE, occurredAt: new Date(t0.getTime() + 40 * 60_000) });
    await evaluateDischargeReady(db, { encounterId, caseId });

    await expect(dischargeDaycare(db, f.recoveryNurse, { encounterId, caseId, isbarAcknowledgedBy: "Lata Gowda" }))
      .rejects.toThrow(/no DISCHARGE-time escort verification/);

    // With the discharge-time verification it goes through, and the bay is released to CLEANING.
    await verifyEscort(db, f.recoveryNurse, { encounterId, at: "discharge", escort: ESCORT });
    await dischargeDaycare(db, f.recoveryNurse, { encounterId, caseId, isbarAcknowledgedBy: "Lata Gowda" });
    expect(await caseState(db, caseId)).toBe("discharged");
    const bay = (await db.select().from(resources).where(eq(resources.id, f.bayIds[0]!)))[0]!;
    // §11.2's cascade in one field: a released bay goes to housekeeping, never to `available`.
    expect({ status: bay.status, occupantRef: bay.occupantRef }).toEqual({ status: "cleaning", occupantRef: null });
    const enc = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, encounterId)))[0]!;
    expect({ status: enc.status, outcome: enc.outcome, bay: enc.bayResourceId })
      .toEqual({ status: "discharged", outcome: "discharged", bay: null });
    expect((await db.select().from(events)).filter((e) => e.name === "escort.verified")).toHaveLength(2);
  });

  it("A21 — an escort whose phone is the PATIENT's is refused; so is a minor escort", async () => {
    const { encounterId } = await inRecovery();
    await expect(verifyEscort(db, f.recoveryNurse, {
      encounterId, at: "discharge", escort: { ...ESCORT, phone: "9800001111" },
    })).rejects.toThrow(/the escort's phone is the patient's own/);
    await expect(verifyEscort(db, f.recoveryNurse, {
      encounterId, at: "discharge", escort: { ...ESCORT, ageYears: 16 },
    })).rejects.toThrow(/must be an adult/);
  });

  /** F24f — a minor is discharged to a guardian holding CONSENT authority, and to nobody else. */
  it("A21 — a MINOR's escort must be a guardian with consent authority (F24f)", async () => {
    const minor = await mkOtPatient(db, f.coordinator, "Baby Devi", {
      phone: "9800005511", dob: new Date(Date.UTC(2016, 0, 1)),
      guardian: {
        name: "Sita Devi", relationship: "mother", phone: "9800006611",
        authorityMessages: true, authorityConsents: false, authorityDsr: false, authorityBills: false,
      },
    });
    const r = await bookCase(db, f.coordinator, {
      patientId: minor, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      anaesthesiaType: "general", listDate: LIST_DATE, payerClass: "self_pay", force: true,
    });
    // The mother holds `messages` only — she may not take the child home.
    await expect(verifyEscort(db, f.recoveryNurse, {
      encounterId: r.encounterId, at: "discharge",
      escort: { ...ESCORT, name: "Sita Devi", relation: "mother", phone: "9800006611" },
    })).rejects.toThrow(/guardian holding CONSENT authority/);
    // A stranger is refused for the same reason.
    await expect(verifyEscort(db, f.recoveryNurse, {
      encounterId: r.encounterId, at: "discharge", escort: { ...ESCORT, name: "A Neighbour" },
    })).rejects.toThrow(/guardian holding CONSENT authority/);
  });

  it("refuses a discharge with no ISBAR acknowledgement (F7)", async () => {
    const { caseId, encounterId } = await inRecovery();
    await admitToBay(db, f.recoveryNurse, { encounterId, bayResourceId: f.bayIds[0]! });
    const t0 = new Date("2026-09-02T06:00:00.000Z");
    await recordScore(db, f.recoveryNurse, { encounterId, caseId, values: GOOD_SCORE, occurredAt: t0 });
    await recordScore(db, f.recoveryNurse, { encounterId, caseId, values: GOOD_SCORE, occurredAt: new Date(t0.getTime() + 40 * 60_000) });
    await evaluateDischargeReady(db, { encounterId, caseId });
    await verifyEscort(db, f.recoveryNurse, { encounterId, at: "discharge", escort: ESCORT });
    await expect(dischargeDaycare(db, f.recoveryNurse, { encounterId, caseId, isbarAcknowledgedBy: "  " }))
      .rejects.toThrow(/ISBAR handover must be acknowledged/);
  });

  // ═══════════════════════════════ A22 ═══════════════════════════════

  /**
   * A22 / R-3.6 — **`convertedAt` IS THE BILLING BOUNDARY**, and a converted encounter is closed:
   * a later discharge on it is refused. The mutant leaves the status `in_recovery`, which is a
   * patient the incumbent IPD is billing and this system still thinks is in its own bay.
   */
  it("A22 — conversion records the boundary instant, releases the bay, and a later discharge is refused", async () => {
    const { caseId, encounterId } = await inRecovery();
    await admitToBay(db, f.recoveryNurse, { encounterId, bayResourceId: f.bayIds[0]! });
    const result = await convertToAdmission(db, f.incharge, {
      encounterId, caseId, reason: "bleeding, needs overnight observation",
    });
    expect(await caseState(db, caseId)).toBe("converted");

    const enc = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, encounterId)))[0]!;
    expect({ status: enc.status, outcome: enc.outcome, bay: enc.bayResourceId, handoff: enc.handoffDocumentId })
      .toEqual({ status: "converted", outcome: "converted", bay: null, handoff: result.handoffDocumentId });
    expect(enc.convertedAt!.toISOString()).toBe(result.convertedAt.toISOString());

    const bay = (await db.select().from(resources).where(eq(resources.id, f.bayIds[0]!)))[0]!;
    expect(bay.status).toBe("cleaning");

    const emitted = (await db.select().from(events)).filter((e) => e.name === "daycare.converted_to_admission");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({ destination: "incumbent_ipd", handoffDocumentId: result.handoffDocumentId });

    // A CONVERTED encounter cannot then be discharged — it is the incumbent's patient now.
    await expect(dischargeDaycare(db, f.recoveryNurse, { encounterId, caseId, isbarAcknowledgedBy: "x" }))
      .rejects.toThrow(/a case in "converted" cannot be discharged/);
  });

  it("§4A-3 — the conversion DESTINATION is a field: naming another one changes the event and nothing else", async () => {
    const { caseId, encounterId } = await inRecovery();
    await convertToAdmission(db, f.incharge, {
      encounterId, caseId, destination: "district_hospital", reason: "referred out",
    });
    const emitted = (await db.select().from(events)).filter((e) => e.name === "daycare.converted_to_admission");
    expect(emitted[0]!.payload).toMatchObject({ destination: "district_hospital" });
  });

  // ═══════════════════════════════ A23 ═══════════════════════════════

  /**
   * ═══ A23 — THE LATE CUT-OFF OFFERS, IT NEVER CONVERTS ═══
   *
   * Threshold met at 20:30 IST. The event carries `lateCutoffPassed: true` and the case reaches
   * `discharge_ready` — a state from which BOTH discharge and conversion are reachable. The mutant
   * auto-converts, which admits a patient overnight without anybody deciding to.
   *
   * The clock is IST, NOT UTC noon (Plan 14's m2): 20:30 IST is 15:00Z, and a UTC comparison would
   * put the cut-off five and a half hours out.
   */
  it("A23 — reaching `discharge_ready` after the cut-off OFFERS conversion; it does not convert", async () => {
    const { caseId, encounterId } = await inRecovery();
    await admitToBay(db, f.recoveryNurse, { encounterId, bayResourceId: f.bayIds[0]! });
    const t0 = new Date("2026-09-02T13:00:00.000Z"); // 18:30 IST
    await recordScore(db, f.recoveryNurse, { encounterId, caseId, values: GOOD_SCORE, occurredAt: t0 });
    await recordScore(db, f.recoveryNurse, { encounterId, caseId, values: GOOD_SCORE, occurredAt: new Date(t0.getTime() + 40 * 60_000) });

    // 20:30 IST = 15:00Z — past the 20:00 cut-off in the criteria.
    const verdict = await evaluateDischargeReady(db, { encounterId, caseId }, new Date("2026-09-02T15:00:00.000Z"));
    expect({ ready: verdict.ready, late: verdict.lateCutoffPassed }).toEqual({ ready: true, late: true });
    // READY, not converted. The offer is the event; the decision is a human's.
    expect(await caseState(db, caseId)).toBe("discharge_ready");
    const enc = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, encounterId)))[0]!;
    expect({ status: enc.status, converted: enc.convertedAt }).toEqual({ status: "in_recovery", converted: null });
    const emitted = (await db.select().from(events)).filter((e) => e.name === "daycare.discharge_ready");
    expect(emitted[0]!.payload).toMatchObject({ lateCutoffPassed: true });
  });

  it("A23 — the cut-off is compared in IST, not UTC (Plan 14 m2)", () => {
    // 15:00Z is 20:30 IST — PAST a 20:00 cut-off. A UTC comparison would call it 15:00 and not past.
    expect(istTimePassed(new Date("2026-09-02T15:00:00.000Z"), "20:00")).toBe(true);
    // 13:00Z is 18:30 IST — not past.
    expect(istTimePassed(new Date("2026-09-02T13:00:00.000Z"), "20:00")).toBe(false);
    // The boundary itself: 14:30Z is exactly 20:00 IST.
    expect(istTimePassed(new Date("2026-09-02T14:30:00.000Z"), "20:00")).toBe(true);
    expect(istTimePassed(new Date("2026-09-02T14:29:00.000Z"), "20:00")).toBe(false);
  });

  // ═══════════════════════════════ N9 ═══════════════════════════════

  it("N9 — an absconded patient is a terminal, the bay is released, and the cause is recorded", async () => {
    const { caseId, encounterId } = await inRecovery();
    await admitToBay(db, f.recoveryNurse, { encounterId, bayResourceId: f.bayIds[0]! });
    await markAbsconded(db, f.recoveryNurse, { encounterId, caseId });
    expect(await caseState(db, caseId)).toBe("absconded");
    const enc = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, encounterId)))[0]!;
    expect({ status: enc.status, outcome: enc.outcome, bay: enc.bayResourceId })
      .toEqual({ status: "absconded", outcome: "absconded", bay: null });
    const emitted = (await db.select().from(events)).filter((e) => e.name === "daycare.absconded");
    // "She left with nobody" and "she left with the man who brought her" are different incidents.
    expect(emitted[0]!.payload).toMatchObject({ escortVerifiedAtDischarge: false });
    expect((await db.select().from(resources).where(eq(resources.id, f.bayIds[0]!)))[0]!.status).toBe("cleaning");
  });

  it("every score is stamped with the bay it was taken in", async () => {
    const { caseId, encounterId } = await inRecovery();
    await admitToBay(db, f.recoveryNurse, { encounterId, bayResourceId: f.bayIds[1]! });
    await recordScore(db, f.recoveryNurse, { encounterId, caseId, values: GOOD_SCORE });
    expect((await db.select().from(pacuScores))[0]!.bayResourceId).toBe(f.bayIds[1]!);
  });

  it("refuses an item value outside the scale's declared maximum", async () => {
    const { caseId, encounterId } = await inRecovery();
    await admitToBay(db, f.recoveryNurse, { encounterId, bayResourceId: f.bayIds[0]! });
    await expect(recordScore(db, f.recoveryNurse, {
      encounterId, caseId, values: { ...GOOD_SCORE, vitals: 5 },
    })).rejects.toThrow(/vitals must be an integer between 0 and 2/);
  });
});
