import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  alerts, erChargeLines, erConsents, erSpecialtyCalls, labAnalytes, orderItems, orders, patients, rosterEscalationTargets, rosterPositions,
  stockLedger, users,
} from "../../kernel/db/schema";
import { setPin } from "../../kernel/auth/identity";
import { withTx } from "../../kernel/db/client";
import { collect, enterResult, printLabels, receive } from "../lab";
import { seedOrgDepartments } from "../roster";
import { serviceIdForLabCode } from "../../../scripts/seed-lab-catalogue";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErCareWorld } from "../../../test/helpers/emergency";
import {
  answerCall, assignErDoctor, callSpecialty, cosignErNote, giveErDose, issueErMed, placeErOrder, readErBoard, recordConsent, recordErNote,
  registerErChargeSink, registerErEncounterResolver, registerUnidentified, returnErMed, sweepErCareClocks,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { ErCareWorld } from "../../../test/helpers/emergency";

/**
 * ER review 2 (2026-10-15, DECIDED as standard practice) — lane 3:
 * - emergency consent: the second doctor confirms with their username and PIN;
 * - `return_er_med`: an unopened unit goes back to ER-SAT and its charge is reversed; an opened unit is wastage (a witness
 *   for a high-alert or controlled drug), the charge stands;
 * - a critical result rings the `er_critical` roster target at the FIRST notice; the wall shows no per-patient critical mark;
 * - the resident rule: a doctor off the doctor master writes a draft; a consultant co-signs;
 * - an answered call keeps its note.
 */
jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 3 — review 2 follow-ups", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErCareWorld;
  const off: (() => void)[] = [];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErCareWorld(db);
    off.push(registerErEncounterResolver(), registerErChargeSink());
  });
  afterEach(() => { while (off.length > 0) off.pop()!(); });

  const unknown = (now = new Date()) => registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "male", ageBand: "adult", arrivalMode: "walk_in" }, { now });
  const usernameOf = async (id: string) => (await db.select({ u: users.username }).from(users).where(eq(users.id, id)))[0]!.u;
  const onHand = async (refId: string) => (await db.select().from(stockLedger).where(eq(stockLedger.refId, refId))).reduce((s, r) => s + Number(r.qtyDelta), 0);

  it("emergency consent: the second doctor confirms with their own username and PIN", async () => {
    const u = await unknown();
    await setPin(db, w.doctor.id, "1357");
    const doctor2 = { username: await usernameOf(w.doctor.id), pin: "1357" };
    const base = { episodeId: u.episodeId, kind: "procedure" as const, about: "Intubation", method: "paper" as const, signedBy: "emergency" as const };
    await expect(recordConsent(db, w.erDoctor, { idempotencyKey: key(), ...base })).rejects.toMatchObject({ code: "emergency_needs_second_doctor" });
    await expect(recordConsent(db, w.erDoctor, { idempotencyKey: key(), ...base, secondDoctor: { ...doctor2, pin: "0000" } })).rejects.toMatchObject({ code: "second_check_failed" });
    await expect(recordConsent(db, w.erDoctor, { idempotencyKey: key(), ...base, secondDoctor: w.pins.nurse2 })).rejects.toMatchObject({ code: "not_a_doctor" });
    const ok = await recordConsent(db, w.erDoctor, { idempotencyKey: key(), ...base, secondDoctor: doctor2 });
    expect((await db.select().from(erConsents).where(eq(erConsents.id, ok.consentId)))[0]!.secondDoctorId).toBe(w.doctor.id);
  });

  it("return_er_med: unopened back to stock with the charge reversed; opened is wastage, witnessed for high-alert, charge stands", async () => {
    const ceftriaxone = await w.stocked("Ceftriaxone 1 g", { qty: 10 });
    const u = await unknown();
    const a = await issueErMed(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, itemId: ceftriaxone, doseWords: "1 g", route: "iv", units: 2, orderedBy: w.erDoctor.id });
    await giveErDose(db, w.erNurse, { idempotencyKey: key(), issueId: a.issueId, outcome: "refused", reason: "Patient declined" });
    const back = await returnErMed(db, w.erNurse, { idempotencyKey: key(), issueId: a.issueId, condition: "unopened", reason: "Dose refused" });
    expect(back).toMatchObject({ kind: "returned" });
    expect(await onHand(a.issueId)).toBe(0); // -2 at issue, +2 on return
    expect((await db.select().from(erChargeLines).where(eq(erChargeLines.issueId, a.issueId)))[0]!.status).toBe("reversed");
    await expect(returnErMed(db, w.erNurse, { idempotencyKey: key(), issueId: a.issueId, condition: "unopened", reason: "again" })).rejects.toMatchObject({ code: "already_returned" });

    const kcl = await w.stocked("Potassium chloride 15%", { highAlert: true });
    const b = await issueErMed(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, itemId: kcl, doseWords: "20 mmol", route: "iv", units: 1, orderedBy: w.erDoctor.id });
    await expect(returnErMed(db, w.erNurse, { idempotencyKey: key(), issueId: b.issueId, condition: "opened", reason: "Drawn up, not given" })).rejects.toMatchObject({ code: "wastage_needs_witness" });
    const wasted = await returnErMed(db, w.erNurse, { idempotencyKey: key(), issueId: b.issueId, condition: "opened", reason: "Drawn up, not given", witness: w.pins.nurse2 });
    expect(wasted).toMatchObject({ kind: "wasted" });
    expect(await onHand(b.issueId)).toBe(-1);
    expect((await db.select().from(erChargeLines).where(eq(erChargeLines.issueId, b.issueId)))[0]!.status).not.toBe("reversed");
    // A returned issue takes no dose; a given dose takes no return.
    await expect(giveErDose(db, w.erNurse, { idempotencyKey: key(), issueId: b.issueId, outcome: "given", secondCheck: w.pins.nurse2 })).rejects.toMatchObject({ code: "issue_returned" });
    const c = await issueErMed(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, itemId: ceftriaxone, doseWords: "1 g", route: "iv", units: 1, orderedBy: w.erDoctor.id });
    await giveErDose(db, w.erNurse, { idempotencyKey: key(), issueId: c.issueId, outcome: "given" });
    await expect(returnErMed(db, w.erNurse, { idempotencyKey: key(), issueId: c.issueId, condition: "unopened", reason: "x" })).rejects.toMatchObject({ code: "dose_given" });
  });

  it("a critical result rings the er_critical target at the first notice; the wall carries no critical mark", async () => {
    await ensureRole(db, "er_charge_doctor");
    const charge = (await mkUser(db, "er.charge", ["er_charge_doctor"])).actor;
    await db.insert(rosterPositions).values({ key: "er_charge_doctor", label: "ER charge doctor", cadre: "faculty", ladderRank: 3, maxPresenceHours: 12, createdBy: "t", updatedBy: "t" } as never);
    await db.insert(rosterEscalationTargets).values({ id: newId(), alertKind: "er_critical", positionKey: "er_charge_doctor", fallbackRoleKey: "er_charge_doctor", createdBy: "t", updatedBy: "t" } as never);
    const t0 = new Date();
    const u = await unknown(t0);
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, doctorId: w.erDoctor.id }, { now: t0 });
    await placeErOrder(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, serviceIds: ["RFT"].map(serviceIdForLabCode), indication: "Weakness" }, { now: t0, orderKinds: w.decls });
    const [o] = await db.select().from(orders).where(eq(orders.encounterNo, u.episodeNo));
    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, o!.id));
    const uhid = (await db.select({ uhid: patients.uhid }).from(patients).where(eq(patients.id, u.patientId)))[0]!.uhid;
    const { specimens } = await printLabels(db, w.bench, { orderGroupId: o!.orderGroupId, scannedUhid: uhid }, t0);
    for (const s of specimens) {
      await withTx(db, (tx) => collect(tx, w.bench, { specimenId: s.specimenId, wristbandScanned: true }, t0));
      await withTx(db, (tx) => receive(tx, w.bench, w.decls, { specimenNo: s.specimenNo }, t0));
    }
    const k = (await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, "K")))[0]!;
    await enterResult(db, w.bench, { orderItemId: item!.id, analyteId: k.id, value: "6.9", entryMode: "manual" }, t0);
    const t1 = new Date(t0.getTime() + MIN);
    await sweepErCareClocks(db, t1);
    const told = (userId: string) => db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.kind, "er.critical_result"), eq(alerts.refId, u.episodeId)));
    expect(await told(w.erDoctor.id)).toHaveLength(1);
    expect(await told(charge.id)).toHaveLength(1);
    expect((await readErBoard(db, w.erDesk, { now: t1 })).inTreatment[0]!.chips).toContain("critical");
    expect((await readErBoard(db, w.erDesk, { now: t1, wall: true })).inTreatment[0]!.chips).not.toContain("critical");
  });

  it("a doctor off the doctor master writes a draft; a consultant co-signs; a doctor off the master cannot", async () => {
    const u = await unknown();
    const mo = (await mkUser(db, "er.mo", ["doctor"])).actor;
    const note = await recordErNote(db, mo, { idempotencyKey: key(), episodeId: u.episodeId, kind: "assessment", text: "Chest pain 2 h" });
    expect(note.status).toBe("draft");
    const mo2 = (await mkUser(db, "er.mo2", ["doctor"])).actor;
    await expect(cosignErNote(db, mo2, { idempotencyKey: key(), noteId: note.noteId })).rejects.toMatchObject({ code: "cosigner_not_senior" });
    await expect(cosignErNote(db, w.erDoctor, { idempotencyKey: key(), noteId: note.noteId })).resolves.toMatchObject({ status: "signed" });
  });

  it("an answered call keeps its note", async () => {
    await seedOrgDepartments(db);
    const u = await unknown();
    const call = await callSpecialty(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, departmentCode: "SUR", urgency: "urgent", reason: "Acute abdomen" });
    await answerCall(db, w.doctor, { idempotencyKey: key(), callId: call.callId, step: "answered", note: "Coming in 10 min" });
    expect((await db.select().from(erSpecialtyCalls).where(eq(erSpecialtyCalls.id, call.callId)))[0]).toMatchObject({ answerNote: "Coming in 10 min" });
  });
});
