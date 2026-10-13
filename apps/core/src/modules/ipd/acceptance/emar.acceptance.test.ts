import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { IPD_INTENTS } from "@hmis/contracts";
import {
  alerts, events, ipdAdmissions, ipdEmarActs, ipdEmarAllergyFlags, ipdEmarDoses, ipdEmarLabels, ipdEmarNarcoticRegister, ipdEmarReturns, ipdOrders,
  patients, stockBalances,
} from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkEmarWorld } from "../../../../test/helpers/ipd";
import { addAllergy } from "../../patients";
import {
  IpdRefusal, administerDose, emarAllergyConsumer, holdDose, issueMed, markDoseInError, placeIpOrder, readLabelSheet, readOverrideCounts,
  readPharmacyQueue, recordNarcoticWastage, reofferHeldDoses, returnMed, secondCheck, signVerbalOrder, stopIpOrder, sweepIpdEmar, verifyOrder,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { EmarWorld } from "../../../../test/helpers/ipd";
import type { Actor } from "@hmis/contracts";

/**
 * E4.3 (#735) — THE eMAR's "DONE MEANS" (spec SPEC-ipd-core §4.6, §6 "Nursing and eMAR"; the brief's checks). Explicit IST
 * instants passed as `now`; nothing reads the real clock. 2026-03-11 is a Wednesday.
 */
jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof IpdRefusal) return e.code;
    if (e instanceof Error && e.name === "ZodError") return "invalid_input";
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("E4.3 eMAR — done means", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: EmarWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkEmarWorld(db); });

  const T0 = ist("2026-03-11T07:00:00");
  /** Admit, order (TDS from 07:00 unless told), verify at 07:30, issue `units` labels; answers ids and the first due time. */
  async function ready(opts: {
    name?: string; drug?: Record<string, unknown>; stock?: Parameters<EmarWorld["stocked"]>[1]; units?: number; stripSize?: number; verify?: boolean;
  } = {}) {
    const { admissionId, patientId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked(opts.name ?? `Zemox ${String(Math.random()).slice(2, 7)}`, opts.stock);
    const placed = await placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId, kind: "drug",
      drug: { itemId: med.medicineId, dose: { value: 500, unit: "mg" }, route: "oral", frequency: "TDS", startAt: T0.toISOString(), antibiotic: false, durationDays: 5, ...opts.drug },
    }, { now: T0 });
    let issueId: string | null = null;
    let labelCode: string | null = null;
    if (opts.verify !== false) {
      await verifyOrder(db, w.pharmacist, {
        idempotencyKey: key(), orderId: placed.orderId, decision: "verified", checks: { allergy: true, interaction: true, dose: true, duplicate: true }, note: "checked",
      }, { now: ist("2026-03-11T07:30:00") });
      const issued = await issueMed(db, w.pharmacist, {
        idempotencyKey: key(), orderId: placed.orderId, units: opts.units ?? 6, ownMedicine: false, ...(opts.stripSize ? { stripSize: opts.stripSize } : {}),
      }, { now: ist("2026-03-11T07:40:00") });
      issueId = issued.issueId;
      labelCode = (await db.select().from(ipdEmarLabels).where(eq(ipdEmarLabels.issueId, issued.issueId)))[0]!.code;
    }
    const band = await w.band(admissionId);
    return { admissionId, patientId, orderId: placed.orderId, med, issueId, labelCode, band };
  }

  const give = (by: Actor, r: { orderId: string; band: string; labelCode: string | null }, at: Date, due: Date, extra: Record<string, unknown> = {}) =>
    administerDose(db, by, {
      idempotencyKey: key(), orderId: r.orderId, doseDueAt: due.toISOString(), givenAt: at.toISOString(),
      patientCheck: { kind: "scan", wristbandCode: r.band }, labelCode: r.labelCode, ...extra,
    }, { now: at });
  const proof = async (by: Actor, who: { username: string; pin: string }, at: Date, orderId: string, purpose: "high_alert_dose" | "infusion" | "narcotic_wastage" = "high_alert_dose", doseDueAt?: Date) =>
    secondCheck(db, by, { idempotencyKey: key(), purpose, orderId, username: who.username, pin: who.pin, ...(doseDueAt ? { doseDueAt: doseDueAt.toISOString() } : {}) }, { now: at });

  it("(i) a patient label for every issued unit or strip — QR code, drug, dose, UHID; a sealed patient by alias, no UHID", async () => {
    const r = await ready({ name: "Labelmycin 500", units: 25, stripSize: 10 });
    const sheet = await readLabelSheet(db, w.pharmacist, r.issueId!);
    expect(sheet.labels.map((l) => [l.seq, l.of, l.units])).toEqual([[1, 3, 10], [2, 3, 10], [3, 3, 5]]);
    const uhid = (await db.select().from(patients).where(eq(patients.id, r.patientId)))[0]!.uhid;
    for (const l of sheet.labels) {
      expect(l.code).toMatch(/^EML-[0-9A-Z]{26}$/);
      expect([l.drug, l.doseWords, l.uhid]).toEqual(["Labelmycin 500 500 mg", "500 mg · oral · TDS", uhid]);
    }
    // One label per unit when no strip is named.
    const unitIssue = await issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, units: 3, ownMedicine: false, reissue: { reason: "extra_supply", note: "Top-up" } }, { now: ist("2026-03-11T08:30:00") });
    expect(unitIssue.labelIds).toHaveLength(3);
    // Sealed: the alias (or "Sealed patient"), no UHID, no bed, no admission number.
    await db.update(patients).set({ sensitiveContext: true, alias: "Patient K" }).where(eq(patients.id, r.patientId));
    const sealed = await readLabelSheet(db, w.pharmacist, r.issueId!);
    expect([sealed.labels[0]!.name, sealed.labels[0]!.uhid, sealed.labels[0]!.bedCode, sealed.labels[0]!.admissionNo]).toEqual(["Patient K", "", null, null]);
    // Stock left the pharmacy store through the ledger: 100 − 25 − 3.
    const bal = (await db.select().from(stockBalances).where(and(eq(stockBalances.resourceId, w.storeId), eq(stockBalances.batchId, r.med.batchId))))[0]!;
    expect(bal.qtyOnHand).toBe(72);
  });

  it("(ii) no give without both scans — a wrong band or a wrong label refuses; a reasoned override records and is counted per nurse and ward", async () => {
    const r = await ready();
    const other = await ready();
    const due = ist("2026-03-11T08:00:00");
    // The neighbour's band (§4.10 edge 7) and the neighbour's label.
    expect(await refusal(give(w.nurse, { ...r, band: other.band }, ist("2026-03-11T08:05:00"), due))).toBe("wrong_patient_scanned");
    expect(await refusal(give(w.nurse, { ...r, labelCode: other.labelCode }, ist("2026-03-11T08:05:00"), due))).toBe("wrong_patient_scanned");
    expect(await refusal(give(w.nurse, { ...r, labelCode: "EML-NOTALABEL" }, ist("2026-03-11T08:05:00"), due))).toBe("wrong_drug_scanned");
    // The same patient's OTHER drug: the label is for another order.
    const med2 = await w.stocked("Otherdrug 500");
    const o2 = await placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId: r.admissionId, kind: "drug",
      drug: { itemId: med2.medicineId, dose: { value: 500, unit: "mg" }, route: "oral", frequency: "BD", startAt: T0.toISOString(), antibiotic: false, durationDays: 3 },
    }, { now: T0 });
    await verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: o2.orderId, decision: "verified", checks: { allergy: true, interaction: true, dose: true, duplicate: true }, note: "checked" }, { now: ist("2026-03-11T07:31:00") });
    const i2 = await issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: o2.orderId, units: 2, ownMedicine: false }, { now: ist("2026-03-11T07:41:00") });
    const wrongLabel = (await db.select().from(ipdEmarLabels).where(eq(ipdEmarLabels.issueId, i2.issueId)))[0]!.code;
    expect(await refusal(give(w.nurse, { ...r, labelCode: wrongLabel }, ist("2026-03-11T08:05:00"), due))).toBe("wrong_drug_scanned");
    // The contract has no give without a patient check and a label.
    expect(IPD_INTENTS.administer_dose.input.safeParse({ idempotencyKey: key(), orderId: r.orderId, doseDueAt: due.toISOString(), givenAt: due.toISOString(), labelCode: r.labelCode }).success).toBe(false);
    expect(IPD_INTENTS.administer_dose.input.safeParse({ idempotencyKey: key(), orderId: r.orderId, doseDueAt: due.toISOString(), givenAt: due.toISOString(), patientCheck: { kind: "scan", wristbandCode: r.band } }).success).toBe(false);
    expect(IPD_INTENTS.administer_dose.input.safeParse({ idempotencyKey: key(), orderId: r.orderId, doseDueAt: due.toISOString(), givenAt: due.toISOString(), labelCode: r.labelCode, patientCheck: { kind: "override", overrideReason: "band_unreadable" } }).success).toBe(false);
    // The override, with its reason: recorded and counted.
    const at = ist("2026-03-11T08:06:00");
    const done = await administerDose(db, w.nurse, {
      idempotencyKey: key(), orderId: r.orderId, doseDueAt: due.toISOString(), givenAt: at.toISOString(),
      patientCheck: { kind: "override", overrideReason: "band_unreadable", note: "Band smudged, reprint asked" }, labelCode: r.labelCode,
    }, { now: at });
    expect(done.overrideCounted).toBe(true);
    await give(w.nurse2, other, ist("2026-03-11T08:07:00"), due);
    const counts = await readOverrideCounts(db, w.nurse, { now: ist("2026-03-11T09:00:00") });
    expect(counts.byNurse.find((n) => n.userId === w.nurse.id)).toMatchObject({ overrides: 1, gives: 1 });
    expect(counts.byNurse.find((n) => n.userId === w.nurse2.id)).toMatchObject({ overrides: 0, gives: 1 });
    expect(counts.byWard.reduce((s, x) => s + x.overrides, 0)).toBe(1);
    expect(counts.byWard.every((x) => x.wardCode !== "—")).toBe(true);
  });

  it("(iii) a high-alert drug needs a REAL second nurse's PIN — never self, never a non-nurse, never a spent proof", async () => {
    const r = await ready({ name: "Actrapid insulin", stock: { highAlert: true, form: "injection", strength: "100 IU/ml" }, drug: { dose: { value: 8, unit: "unit" }, route: "sc" } });
    const due = ist("2026-03-11T08:00:00");
    const at = ist("2026-03-11T07:55:00");
    expect(await refusal(give(w.nurse, r, at, due))).toBe("second_nurse_required");
    expect(await refusal(proof(w.nurse, w.pins.nurse, at, r.orderId))).toBe("second_nurse_same_person");
    expect(await refusal(proof(w.nurse, w.pins.consultant, at, r.orderId))).toBe("second_nurse_not_nurse");
    expect(await refusal(proof(w.nurse, { ...w.pins.nurse2, pin: "0000" }, at, r.orderId))).toBe("second_nurse_not_confirmed");
    const p = await proof(w.nurse, w.pins.nurse2, at, r.orderId, "high_alert_dose", due);
    expect(p.userId).toBe(w.nurse2.id);
    // A proof names its checker: claiming it for yourself is refused.
    expect(await refusal(give(w.nurse, r, at, due, { secondNurse: { userId: w.nurse.id, pinProof: p.pinProof } }))).toBe("second_nurse_same_person");
    const ok = await give(w.nurse, r, at, due, { secondNurse: { userId: w.nurse2.id, pinProof: p.pinProof } });
    expect((await db.select().from(ipdEmarActs).where(eq(ipdEmarActs.id, ok.administrationId)))[0]!.secondNurseId).toBe(w.nurse2.id);
    // Spent: the same proof cannot carry the next dose.
    expect(await refusal(give(w.nurse, r, ist("2026-03-11T14:00:00"), ist("2026-03-11T14:00:00"), { secondNurse: { userId: w.nurse2.id, pinProof: p.pinProof } }))).toBe("second_nurse_required");
  });

  it("(iii-b) an unflagged KCl or insulin is still high-alert by name (belt and braces)", async () => {
    const r = await ready({ name: "Potassium chloride 15% inj", stock: { form: "injection", strength: "150 mg/ml" }, drug: { dose: { value: 10, unit: "ml" }, route: "iv" } });
    expect(await refusal(give(w.nurse, r, ist("2026-03-11T08:00:00"), ist("2026-03-11T08:00:00")))).toBe("second_nurse_required");
  });

  it("(iv) PRN — the minimum interval and the 24-hour maximum are enforced", async () => {
    const r = await ready({ stripSize: 6, drug: { frequency: "SOS", prn: { minIntervalMinutes: 240, max24h: 3 } } });
    const at = (s: string) => ist(`2026-03-11T${s}`);
    await give(w.nurse, r, at("08:00:00"), at("08:00:00"));
    expect(await refusal(give(w.nurse, r, at("11:59:00"), at("11:59:00")))).toBe("prn_interval_not_met");
    await give(w.nurse, r, at("12:00:00"), at("12:00:00"));
    await give(w.nurse, r, at("16:00:00"), at("16:00:00"));
    expect(await refusal(give(w.nurse, r, at("20:30:00"), at("20:30:00")))).toBe("prn_daily_max_reached");
    // 24 hours after the first, a fourth is allowed again.
    await give(w.nurse, r, ist("2026-03-12T08:01:00"), ist("2026-03-12T08:01:00"));
  });

  it("(v) an allergy added later re-checks every active order: the doctor and the pharmacist are told, and the give is refused", async () => {
    const r = await ready({ name: "Zemoxicillin 500", stock: { moiety: "Zemoxicillin" } });
    await withTx(db, (tx) => addAllergy(tx, w.admitDesk, r.patientId, { substance: "Zemoxicillin", severity: "severe", source: "consult" }));
    const ev = (await db.select().from(events).where(and(eq(events.name, "allergy.recorded"), eq(events.patientId, r.patientId))))[0]!;
    const consumer = emarAllergyConsumer(db);
    const deliver = () => consumer({ seq: Number(ev.seq), eventId: ev.eventId, name: ev.name, payload: ev.payload, patientId: ev.patientId, correlationId: ev.correlationId, occurredAt: ist("2026-03-11T07:50:00") } as never);
    await deliver();
    await deliver(); // a redelivery raises nothing twice
    const flags = await db.select().from(ipdEmarAllergyFlags).where(eq(ipdEmarAllergyFlags.orderId, r.orderId));
    expect(flags).toHaveLength(1);
    const told = await db.select().from(alerts).where(eq(alerts.sourceEventId, `ipd.emar.allergy:${flags[0]!.id}`));
    expect(told.map((x) => x.userId)).toEqual(expect.arrayContaining([w.consultant.id, w.pharmacist.id]));
    expect(await refusal(give(w.nurse, r, ist("2026-03-11T08:00:00"), ist("2026-03-11T08:00:00")))).toBe("allergy_conflict");
    expect((await readPharmacyQueue(db, w.pharmacist, { now: ist("2026-03-11T08:00:00") })).allergyFlags.map((f) => f.orderId)).toEqual([r.orderId]);
  });

  it("(vi) NPO hold re-offers: the held dose takes no give until the patient is back, then is offered again", async () => {
    const r = await ready();
    const due = ist("2026-03-11T08:00:00");
    const held = await holdDose(db, w.nurse, { idempotencyKey: key(), orderId: r.orderId, doseDueAt: due.toISOString(), reason: "npo", note: "OT list" }, { now: ist("2026-03-11T07:50:00") });
    expect(held.reofferOnReturn).toBe(true);
    expect(await refusal(give(w.nurse, r, ist("2026-03-11T08:10:00"), due))).toBe("dose_already_recorded");
    // Back at 11:00 (past the dose's own window): re-offered with a fresh window.
    expect((await reofferHeldDoses(db, w.nurse, { idempotencyKey: key(), admissionId: r.admissionId, reason: "npo_lifted" }, { now: ist("2026-03-11T11:00:00") })).reoffered).toBe(1);
    const ok = await give(w.nurse, r, ist("2026-03-11T11:10:00"), due);
    expect(ok.late).toBe(false);
    // A clinical hold does not re-offer.
    const held2 = await holdDose(db, w.nurse, { idempotencyKey: key(), orderId: r.orderId, doseDueAt: ist("2026-03-11T14:00:00").toISOString(), reason: "parameter_out_of_range" }, { now: ist("2026-03-11T13:50:00") });
    expect(held2.reofferOnReturn).toBe(false);
  });

  it("(vii) a verbal order is refused for a high-alert drug; an emergency one is recorded, signed by the doctor within 24 h", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const insulin = await w.stocked("Insulin glargine", { form: "injection", strength: "100 IU/ml" });
    const para = await w.stocked("Paracetamol IV", { form: "injection", strength: "1 g" });
    const verbal = (itemId: string, dose: Record<string, unknown>, route: string) => placeIpOrder(db, w.nurse, {
      idempotencyKey: key(), admissionId, kind: "drug",
      drug: { itemId, dose, route, frequency: "STAT", startAt: T0.toISOString(), antibiotic: false, durationDays: 1 },
      verbal: { fromDoctorId: w.consultant.id, readBack: true, emergency: "acute_deterioration", emergencyNote: "Fever 104F, doctor in OT" },
    }, { now: T0 });
    expect(await refusal(verbal(insulin.medicineId, { value: 10, unit: "unit" }, "sc"))).toBe("verbal_order_not_allowed");
    // A nurse cannot write an ordinary order.
    expect(await refusal(placeIpOrder(db, w.nurse, {
      idempotencyKey: key(), admissionId, kind: "drug",
      drug: { itemId: para.medicineId, dose: { value: 1, unit: "g" }, route: "iv", frequency: "STAT", startAt: T0.toISOString(), antibiotic: false, durationDays: 1 },
    }, { now: T0 }))).toBe("verbal_order_only");
    const ok = await verbal(para.medicineId, { value: 1, unit: "g" }, "iv");
    expect(ok.signBy).toBe(new Date(T0.getTime() + 24 * 3_600_000).toISOString());
    const row = (await db.select().from(ipdOrders).where(eq(ipdOrders.id, ok.orderId)))[0]!;
    expect([row.orderedBy, row.verification]).toEqual([w.consultant.id, "pending"]);
    // 20 h on, unsigned: the sweep nudges the doctor once.
    expect((await sweepIpdEmar(db, ist("2026-03-12T03:30:00"))).verbalNudged).toBe(1);
    expect((await sweepIpdEmar(db, ist("2026-03-12T03:31:00"))).verbalNudged).toBe(0);
    expect(await refusal(signVerbalOrder(db, w.outsider, { idempotencyKey: key(), orderId: ok.orderId }, { now: ist("2026-03-11T09:00:00") }))).toBe("not_treating_team");
    await signVerbalOrder(db, w.consultant, { idempotencyKey: key(), orderId: ok.orderId }, { now: ist("2026-03-11T09:00:00") });
    expect(await refusal(signVerbalOrder(db, w.consultant, { idempotencyKey: key(), orderId: ok.orderId }, { now: ist("2026-03-11T09:01:00") }))).toBe("verbal_order_signed");
  });

  it("(viii) a give is refused offline: a client stamp more than 2 minutes before the server's clock is give_expired", async () => {
    const r = await ready();
    const due = ist("2026-03-11T08:00:00");
    const stale = administerDose(db, w.nurse, {
      idempotencyKey: key(), orderId: r.orderId, doseDueAt: due.toISOString(), givenAt: ist("2026-03-11T08:00:00").toISOString(),
      patientCheck: { kind: "scan", wristbandCode: r.band }, labelCode: r.labelCode,
    }, { now: ist("2026-03-11T08:02:01") });
    expect(await refusal(stale)).toBe("give_expired");
    expect(await db.select().from(ipdEmarActs).where(eq(ipdEmarActs.orderId, r.orderId))).toHaveLength(0);
    // Inside the skew it records.
    await administerDose(db, w.nurse, {
      idempotencyKey: key(), orderId: r.orderId, doseDueAt: due.toISOString(), givenAt: ist("2026-03-11T08:00:00").toISOString(),
      patientCheck: { kind: "scan", wristbandCode: r.band }, labelCode: r.labelCode,
    }, { now: ist("2026-03-11T08:01:30") });
  });

  it("(ix) a dose given in error is never deleted: entered-in-error reopens the slot; an incident keeps the dose and logs it", async () => {
    const r = await ready();
    const due = ist("2026-03-11T08:00:00");
    const g = await give(w.nurse, r, ist("2026-03-11T08:00:00"), due);
    const c = await markDoseInError(db, w.nurse, { idempotencyKey: key(), actId: g.administrationId, kind: "entered_in_error", reason: "Charted on the wrong patient" }, { now: ist("2026-03-11T08:10:00") });
    expect(c.incidentNo).toBeNull();
    const acts = await db.select().from(ipdEmarActs).where(eq(ipdEmarActs.orderId, r.orderId));
    expect(acts.map((x) => x.kind).sort()).toEqual(["entered_in_error", "given"]);
    // The table itself refuses a delete or an edit.
    await expect(db.execute(sql`delete from ipd_emar_acts where id = ${g.administrationId}`)).rejects.toThrow(/append-only/);
    await expect(db.execute(sql`update ipd_emar_acts set kind = 'held' where id = ${g.administrationId}`)).rejects.toThrow(/append-only/);
    expect(await refusal(markDoseInError(db, w.nurse, { idempotencyKey: key(), actId: g.administrationId, kind: "entered_in_error", reason: "again" }, { now: ist("2026-03-11T08:11:00") }))).toBe("dose_act_already_corrected");
    // The slot is open again: the real dose is recorded.
    const g2 = await give(w.nurse, r, ist("2026-03-11T08:20:00"), due);
    const inc = await markDoseInError(db, w.nurse, {
      idempotencyKey: key(), actId: g2.administrationId, kind: "medication_incident", reason: "Given 500 mg, ordered 250 mg", incident: { type: "wrong_dose", category: "C" },
    }, { now: ist("2026-03-11T08:30:00") });
    expect(inc.incidentNo).toMatch(/^MI-\d{6}$/);
    expect((await db.select().from(ipdEmarDoses).where(and(eq(ipdEmarDoses.orderId, r.orderId), eq(ipdEmarDoses.dueAt, due))))[0]!.status).toBe("given");
  });

  it("(x) narcotic wastage needs a witnessing second nurse", async () => {
    const r = await ready({ name: "Morphine 10 mg inj", stock: { narcotic: true, form: "injection", strength: "10 mg/ml" }, drug: { dose: { value: 5, unit: "mg" }, route: "iv" } });
    const at = ist("2026-03-11T08:00:00");
    const waste = (witness: unknown) => recordNarcoticWastage(db, w.nurse, { idempotencyKey: key(), orderId: r.orderId, qty: 0.5, reason: "Half ampoule unused", witness }, { now: at });
    expect(await refusal(waste(undefined))).toBe("invalid_input");
    expect(await refusal(waste({ userId: w.nurse.id, pinProof: "x" }))).toBe("second_nurse_same_person");
    expect(await refusal(waste({ userId: w.nurse2.id, pinProof: "01AAAAAAAAAAAAAAAAAAAAAAAA" }))).toBe("second_nurse_required");
    const p = await proof(w.nurse, w.pins.nurse2, at, r.orderId, "narcotic_wastage");
    await waste({ userId: w.nurse2.id, pinProof: p.pinProof });
    const reg = await db.select().from(ipdEmarNarcoticRegister).where(eq(ipdEmarNarcoticRegister.orderId, r.orderId));
    expect(reg.map((x) => x.kind).sort()).toEqual(["received", "wasted"]);
    expect(reg.find((x) => x.kind === "wasted")!.witnessId).toBe(w.nurse2.id);
    // The database refuses an unwitnessed wastage row too.
    await expect(db.insert(ipdEmarNarcoticRegister).values({
      id: "01BBBBBBBBBBBBBBBBBBBBBBBB", orderId: r.orderId, admissionId: r.admissionId, kind: "wasted", qty: 1, unit: "ml", actorId: w.nurse.id, at,
    })).rejects.toThrow(/ipd_emar_narcotic_witness_ck/);
  });

  it("(xi) stopped after issue: future doses are cancelled and the return comes back with its units credited", async () => {
    const r = await ready({ units: 10 });
    await give(w.nurse, r, ist("2026-03-11T08:00:00"), ist("2026-03-11T08:00:00"));
    const stop = await stopIpOrder(db, w.consultant, { idempotencyKey: key(), orderId: r.orderId, reason: "Switched to IV" }, { now: ist("2026-03-11T10:00:00") });
    expect(stop.returnOwed).toBe(true);
    const slots = await db.select().from(ipdEmarDoses).where(eq(ipdEmarDoses.orderId, r.orderId));
    expect(slots.filter((s) => s.status === "scheduled")).toHaveLength(0);
    expect(slots.filter((s) => s.status === "given")).toHaveLength(1);
    expect(slots.filter((s) => s.status === "cancelled").length).toBeGreaterThan(3);
    expect(await refusal(give(w.nurse, r, ist("2026-03-11T14:00:00"), ist("2026-03-11T14:00:00")))).toBe("order_not_active");
    const q = await readPharmacyQueue(db, w.pharmacist, { now: ist("2026-03-11T10:05:00") });
    expect(q.returnsOwed.map((x) => [x.issueId, x.units, x.returnedUnits])).toEqual([[r.issueId, 10, 0]]);
    expect(await refusal(returnMed(db, w.pharmacist, { idempotencyKey: key(), issueId: r.issueId, units: 11, reason: "count" }, { now: ist("2026-03-11T10:10:00") }))).toBe("return_exceeds_issue");
    const back = await returnMed(db, w.pharmacist, { idempotencyKey: key(), issueId: r.issueId, units: 9, reason: "Order stopped" }, { now: ist("2026-03-11T10:10:00") });
    expect(back.creditedUnits).toBe(9);
    expect((await db.select().from(ipdEmarReturns).where(eq(ipdEmarReturns.issueId, r.issueId!)))[0]!.creditedUnits).toBe(9);
    const bal = (await db.select().from(stockBalances).where(and(eq(stockBalances.resourceId, w.storeId), eq(stockBalances.batchId, r.med.batchId))))[0]!;
    expect(bal.qtyOnHand).toBe(99);
    expect((await db.select().from(ipdOrders).where(eq(ipdOrders.id, r.orderId)))[0]!.returnOwed).toBe(false);
  });

  it("(xii) two nurses giving the same dose at once record exactly one administration", async () => {
    const r = await ready();
    const due = ist("2026-03-11T08:00:00");
    const at = ist("2026-03-11T08:01:00");
    const both = await Promise.allSettled([give(w.nurse, r, at, due), give(w.nurse2, r, at, due)]);
    expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const lost = both.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as IpdRefusal).code).toBe("dose_already_recorded");
    expect(await db.select().from(ipdEmarActs).where(and(eq(ipdEmarActs.orderId, r.orderId), eq(ipdEmarActs.kind, "given")))).toHaveLength(1);
  });

  it("(xiii) verify: the four ticks, a note for a finding; doses scheduled at the IST round times; a missed dose alerts once", async () => {
    const r = await ready({ verify: false, name: "Duplimax 500", stock: { moiety: "Duplimax" } });
    const ticks = { allergy: true, interaction: true, dose: true, duplicate: false };
    const at = ist("2026-03-11T07:30:00");
    expect(await refusal(verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, decision: "verified", checks: ticks }, { now: at }))).toBe("checks_incomplete");
    expect(await refusal(verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, decision: "rejected", checks: ticks }, { now: at }))).toBe("verify_note_required");
    expect(await refusal(issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, units: 2, ownMedicine: false }, { now: at }))).toBe("order_not_verified");
    expect(await refusal(verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, decision: "verified", checks: { ...ticks, duplicate: true } }, { now: at }))).toBe("verify_note_required");
    const v = await verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, decision: "verified", checks: { ...ticks, duplicate: true }, note: "No interaction data: checked by hand" }, { now: at });
    // TDS 08 / 14 / 20 IST from 07:30 to the 36-hour horizon: 11-Mar 08, 14, 20; 12-Mar 08, 14 (19:30 is the edge).
    const slots = await db.select().from(ipdEmarDoses).where(eq(ipdEmarDoses.orderId, r.orderId));
    expect(v.dosesScheduled).toBe(slots.length);
    expect(slots.map((s) => s.dueAt.toISOString()).sort()).toEqual([
      ist("2026-03-11T08:00:00"), ist("2026-03-11T14:00:00"), ist("2026-03-11T20:00:00"), ist("2026-03-12T08:00:00"), ist("2026-03-12T14:00:00"),
    ].map((d) => d.toISOString()));
    expect(slots.every((s) => s.windowMinutes === 60)).toBe(true);
    // Nobody gives the 08:00 dose: at 09:01 the sweep marks it missed and alerts once; the next tick says nothing.
    expect((await sweepIpdEmar(db, ist("2026-03-11T09:01:00"))).missed).toBe(1);
    expect((await sweepIpdEmar(db, ist("2026-03-11T09:02:00"))).missed).toBe(0);
    const slot = (await db.select().from(ipdEmarDoses).where(and(eq(ipdEmarDoses.orderId, r.orderId), eq(ipdEmarDoses.dueAt, ist("2026-03-11T08:00:00")))))[0]!;
    expect(slot.status).toBe("missed");
    expect((await db.select().from(alerts).where(eq(alerts.sourceEventId, `ipd.emar.missed:${slot.id}`))).length).toBeGreaterThan(0);
    // A second active order of the same moiety is a duplicate-therapy finding.
    const dup = await placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId: r.admissionId, kind: "drug",
      drug: { itemId: (await w.stocked("Duplimax DT", { moiety: "Duplimax" })).medicineId, dose: { value: 500, unit: "mg" }, route: "oral", frequency: "BD", startAt: T0.toISOString(), antibiotic: false, durationDays: 3 },
    }, { now: ist("2026-03-11T09:00:00") });
    const q = await readPharmacyQueue(db, w.pharmacist, { now: ist("2026-03-11T09:05:00") });
    const item = q.toVerify.find((x) => x.order.orderId === dup.orderId)!;
    expect(item.findings.map((f) => f.check)).toContain("duplicate");
    expect(await refusal(verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: dup.orderId, decision: "verified", checks: { ...ticks, duplicate: true } }, { now: ist("2026-03-11T09:06:00") }))).toBe("verify_note_required");
  });

  it("(xiv) a time-critical drug (an antibiotic) has a ±30-minute window; a late give needs its reason", async () => {
    const r = await ready({ stock: { aware: "Access" }, drug: { antibiotic: true, stopAt: ist("2026-03-15T07:00:00").toISOString(), durationDays: undefined } });
    const slot = (await db.select().from(ipdEmarDoses).where(and(eq(ipdEmarDoses.orderId, r.orderId), eq(ipdEmarDoses.dueAt, ist("2026-03-11T08:00:00")))))[0]!;
    expect(slot.windowMinutes).toBe(30);
    expect(await refusal(give(w.nurse, r, ist("2026-03-11T07:20:00"), ist("2026-03-11T08:00:00")))).toBe("outside_due_window");
    expect(await refusal(give(w.nurse, r, ist("2026-03-11T08:45:00"), ist("2026-03-11T08:00:00")))).toBe("late_reason_required");
    const late = await give(w.nurse, r, ist("2026-03-11T08:45:00"), ist("2026-03-11T08:00:00"), { lateReason: "Patient in X-ray" });
    expect(late.late).toBe(true);
  });

  it("(xv) a retried give records once (the idempotency key)", async () => {
    const r = await ready();
    const at = ist("2026-03-11T08:00:00");
    const body = {
      idempotencyKey: key(), orderId: r.orderId, doseDueAt: at.toISOString(), givenAt: at.toISOString(),
      patientCheck: { kind: "scan" as const, wristbandCode: r.band }, labelCode: r.labelCode,
    };
    const a = await administerDose(db, w.nurse, body, { now: at });
    const b = await administerDose(db, w.nurse, body, { now: at });
    expect(b.administrationId).toBe(a.administrationId);
    expect(await db.select().from(ipdEmarActs).where(eq(ipdEmarActs.orderId, r.orderId))).toHaveLength(1);
  });

  it("(xvi) a dose for a discharged stay is refused", async () => {
    const r = await ready();
    await db.update(ipdAdmissions).set({ state: "discharged" }).where(eq(ipdAdmissions.id, r.admissionId));
    expect(await refusal(give(w.nurse, r, ist("2026-03-11T08:00:00"), ist("2026-03-11T08:00:00")))).toBe("order_not_active");
  });
});
