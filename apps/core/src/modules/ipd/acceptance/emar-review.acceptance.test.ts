import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { IPD_INTENTS, newId } from "@hmis/contracts";
import {
  alerts, dietNpo, ipdEmarActs, ipdEmarAllergyFlags, ipdEmarDoses, ipdEmarLabels, ipdEmarNarcoticRegister, ipdOrders, patientAllergies,
  pharmacyMedicationIncidents,
} from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkEmarWorld } from "../../../../test/helpers/ipd";
import { mkUser } from "../../../../test/helpers/opd";
import { addAllergy } from "../../patients";
import {
  IpdRefusal, administerDose, backfillEmarAllergyFlags, decideAllergyFlag, emarAllergyConsumer, holdDose, issueMed, markDoseInError,
  placeIpOrder, readEmarPatient, readOverrideCounts, readPharmacyQueue, recordInfusionEvent, recordNarcoticWastage, resolveAllergyFlag,
  returnMed, secondCheck, stopIpOrder, verifyOrder,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { EmarWorld } from "../../../../test/helpers/ipd";
import type { Actor } from "@hmis/contracts";

/**
 * E4.3 (#735) — THE REVIEW OF d500eb13 / 32700d61, as checks. Each leg names its finding; each was shown red against the
 * guard removed (the lane's mutant run). Explicit IST instants passed as `now`; nothing reads the real clock.
 */
jest.setTimeout(300_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();
const TICKS = { allergy: true, interaction: true, dose: true, duplicate: true };

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

describe("E4.3 eMAR — review of d500eb13", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: EmarWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkEmarWorld(db); });

  const T0 = ist("2026-03-11T07:00:00");
  type Ready = { admissionId: string; patientId: string; orderId: string; med: { medicineId: string; itemId: string; batchId: string }; issueId: string | null; labelCode: string | null; band: string };
  async function ready(opts: {
    name?: string; drug?: Record<string, unknown>; stock?: Parameters<EmarWorld["stocked"]>[1]; units?: number; stripSize?: number; verify?: boolean;
    admissionId?: string; medicineId?: string;
  } = {}): Promise<Ready> {
    const adm = opts.admissionId !== undefined ? { admissionId: opts.admissionId } : await w.admitMed(ist("2026-03-10T10:00:00"));
    const admissionId = adm.admissionId;
    const med = opts.medicineId !== undefined ? { medicineId: opts.medicineId, itemId: "", batchId: "" } : await w.stocked(opts.name ?? `Zemox ${String(Math.random()).slice(2, 7)}`, opts.stock);
    const placed = await placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId, kind: "drug",
      drug: { itemId: med.medicineId, dose: { value: 500, unit: "mg" }, route: "oral", frequency: "TDS", startAt: T0.toISOString(), antibiotic: false, durationDays: 5, ...opts.drug },
    }, { now: T0 });
    let issueId: string | null = null;
    let labelCode: string | null = null;
    if (opts.verify !== false) {
      await verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, decision: "verified", checks: TICKS, note: "checked" }, { now: ist("2026-03-11T07:30:00") });
      const issued = await issueMed(db, w.pharmacist, {
        idempotencyKey: key(), orderId: placed.orderId, units: opts.units ?? 6, ownMedicine: false, ...(opts.stripSize ? { stripSize: opts.stripSize } : {}),
      }, { now: ist("2026-03-11T07:40:00") });
      issueId = issued.issueId;
      labelCode = (await db.select().from(ipdEmarLabels).where(eq(ipdEmarLabels.issueId, issued.issueId)))[0]!.code;
    }
    const patientId = (await db.select().from(ipdOrders).where(eq(ipdOrders.id, placed.orderId)))[0]!.patientId;
    const band = opts.admissionId !== undefined ? (await db.execute(sql`select serial from ipd_bands where admission_id = ${admissionId} and status = 'printed'`)).rows[0]!.serial as string : await w.band(admissionId);
    return { admissionId, patientId, orderId: placed.orderId, med, issueId, labelCode, band };
  }
  const give = (by: Actor, r: { orderId: string; band: string; labelCode: string | null }, at: Date, due: Date, extra: Record<string, unknown> = {}) =>
    administerDose(db, by, {
      idempotencyKey: key(), orderId: r.orderId, doseDueAt: due.toISOString(), givenAt: at.toISOString(),
      patientCheck: { kind: "scan", wristbandCode: r.band }, labelCode: r.labelCode, ...extra,
    }, { now: at });
  const proof = (by: Actor, who: { username: string; pin: string }, at: Date, orderId: string, purpose: "high_alert_dose" | "infusion" | "narcotic_wastage", doseDueAt?: Date) =>
    secondCheck(db, by, { idempotencyKey: key(), purpose, orderId, username: who.username, pin: who.pin, ...(doseDueAt ? { doseDueAt: doseDueAt.toISOString() } : {}) }, { now: at });
  const H = (h: string) => ist(`2026-03-11T${h}:00`);

  it("RED 1 — a label's units are a ledger: spent units refuse a replay; a returned or superseded issue's label is void", async () => {
    // Two tablets on one strip label, one tablet a dose.
    const r = await ready({ units: 2, stripSize: 2 });
    await give(w.nurse, r, H("08:00"), H("08:00"));
    await give(w.nurse, r, H("14:00"), H("14:00"));
    expect(await refusal(give(w.nurse, r, H("20:00"), H("20:00")))).toBe("label_exhausted");
    // A half tablet a dose: one tablet lasts two doses.
    const half = await ready({ units: 1, drug: { dose: { value: 250, unit: "mg" } } });
    await give(w.nurse, half, H("08:00"), H("08:00"));
    await give(w.nurse, half, H("14:00"), H("14:00"));
    expect(await refusal(give(w.nurse, half, H("20:00"), H("20:00")))).toBe("label_exhausted");
    // Re-issue LOST: the old label no longer counts, the new one does.
    const lost = await ready({ units: 6 });
    const again = await issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: lost.orderId, units: 6, ownMedicine: false, reissue: { reason: "lost", note: "Strip dropped" } }, { now: H("07:50") });
    expect(await refusal(give(w.nurse, lost, H("08:00"), H("08:00")))).toBe("label_void");
    const fresh = (await db.select().from(ipdEmarLabels).where(eq(ipdEmarLabels.issueId, again.issueId)))[0]!.code;
    await give(w.nurse, { ...lost, labelCode: fresh }, H("08:01"), H("08:00"));
    // A returned issue's label no longer counts.
    const back = await ready({ units: 6 });
    await returnMed(db, w.pharmacist, { idempotencyKey: key(), issueId: back.issueId!, units: 2, reason: "count" }, { now: H("07:55") });
    expect(await refusal(give(w.nurse, back, H("08:00"), H("08:00")))).toBe("label_void");
  });

  it("RED 2 — a second-nurse proof is bound to its purpose, order, slot and drug", async () => {
    const stock = { highAlert: true, form: "injection", strength: "100 IU/ml" };
    const drug = { dose: { value: 8, unit: "unit" }, route: "sc" };
    const a = await ready({ name: "Actrapid A", stock, drug });
    const b = await ready({ name: "Actrapid B", stock, drug });
    const at = H("07:55");
    const forA = await proof(w.nurse, w.pins.nurse2, at, a.orderId, "high_alert_dose", H("08:00"));
    expect(await refusal(give(w.nurse, b, at, H("08:00"), { secondNurse: { userId: w.nurse2.id, pinProof: forA.pinProof } }))).toBe("second_nurse_required");
    const otherPurpose = await proof(w.nurse, w.pins.nurse2, at, a.orderId, "infusion");
    expect(await refusal(give(w.nurse, a, at, H("08:00"), { secondNurse: { userId: w.nurse2.id, pinProof: otherPurpose.pinProof } }))).toBe("second_nurse_required");
    const otherSlot = await proof(w.nurse, w.pins.nurse2, at, a.orderId, "high_alert_dose", H("14:00"));
    expect(await refusal(give(w.nurse, a, at, H("08:00"), { secondNurse: { userId: w.nurse2.id, pinProof: otherSlot.pinProof } }))).toBe("second_nurse_required");
    await give(w.nurse, a, at, H("08:00"), { secondNurse: { userId: w.nurse2.id, pinProof: forA.pinProof } });
  });

  it("RED 3 — PRN limits belong to the moiety across the admission's PRN orders; a second PRN of it is a hard stop at verify", async () => {
    const prn = { frequency: "SOS", prn: { minIntervalMinutes: 240, max24h: 3 } };
    const a = await ready({ name: "Fevex 500", stock: { moiety: "Febrinol" }, drug: prn });
    const second = await w.stocked("Pyrex 500", { moiety: "Febrinol" });
    const b = await ready({ admissionId: a.admissionId, medicineId: second.medicineId, drug: prn, verify: false });
    const q = await readPharmacyQueue(db, w.pharmacist, { now: H("07:45") });
    const item = q.toVerify.find((x) => x.order.orderId === b.orderId)!;
    expect(item.findings.find((f) => f.check === "duplicate")).toMatchObject({ severity: "stop" });
    expect(await refusal(verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: b.orderId, decision: "verified", checks: TICKS }, { now: H("07:46") }))).toBe("verify_note_required");
    await verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: b.orderId, decision: "verified", checks: TICKS, note: "Doctor wants both; limits shared" }, { now: H("07:47") });
    const issued = await issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: b.orderId, units: 6, ownMedicine: false, batchId: second.batchId }, { now: H("07:48") });
    const bLabel = (await db.select().from(ipdEmarLabels).where(eq(ipdEmarLabels.issueId, issued.issueId)))[0]!.code;
    await give(w.nurse, a, H("08:00"), H("08:00"));
    expect(await refusal(give(w.nurse, { ...b, labelCode: bLabel }, H("09:00"), H("09:00")))).toBe("prn_interval_not_met");
  });

  it("RED 4 — a named batch must be the medicine's stocked item, in the pharmacy store", async () => {
    const r = await ready({ verify: false });
    await verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, decision: "verified", checks: TICKS, note: "checked" }, { now: H("07:30") });
    const other = await w.stocked("Unrelated 10");
    expect(await refusal(issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, units: 2, ownMedicine: false, batchId: other.batchId }, { now: H("07:40") }))).toBe("batch_mismatch");
    const elsewhere = await w.batchElsewhere(r.med.itemId);
    expect(await refusal(issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, units: 2, ownMedicine: false, batchId: elsewhere }, { now: H("07:40") }))).toBe("batch_mismatch");
    await issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, units: 2, ownMedicine: false, batchId: r.med.batchId }, { now: H("07:41") });
  });

  it("RED 5 / RED 6 — the narcotic register keeps one base unit and reconciles; entered-in-error appends its reversal", async () => {
    const r = await ready({
      name: "Morphine 10 mg/ml inj", stock: { narcotic: true, form: "injection", strength: "10 mg/ml", baseUom: "ampoule" },
      drug: { dose: { value: 5, unit: "mg" }, route: "iv", frequency: "BD" }, units: 4,
    });
    const g1 = await give(w.nurse, r, H("09:00"), H("09:00"), { secondNurse: await proof(w.nurse, w.pins.nurse2, H("09:00"), r.orderId, "high_alert_dose", H("09:00")).then((p) => ({ userId: p.userId, pinProof: p.pinProof })) });
    await give(w.nurse, r, H("21:00"), H("21:00"), { secondNurse: await proof(w.nurse, w.pins.nurse2, H("21:00"), r.orderId, "high_alert_dose", H("21:00")).then((p) => ({ userId: p.userId, pinProof: p.pinProof })) });
    const p = await proof(w.nurse, w.pins.nurse2, H("21:05"), r.orderId, "narcotic_wastage");
    await recordNarcoticWastage(db, w.nurse, { idempotencyKey: key(), orderId: r.orderId, qty: 0.5, reason: "Half ampoule discarded", witness: { userId: p.userId, pinProof: p.pinProof } }, { now: H("21:05") });
    await markDoseInError(db, w.nurse, { idempotencyKey: key(), actId: g1.administrationId, kind: "entered_in_error", reason: "Charted twice" }, { now: H("21:10") });
    await returnMed(db, w.pharmacist, { idempotencyKey: key(), issueId: r.issueId!, units: 2, reason: "Order changed" }, { now: H("21:20") });
    const reg = await db.select().from(ipdEmarNarcoticRegister).where(eq(ipdEmarNarcoticRegister.orderId, r.orderId));
    expect(new Set(reg.map((x) => x.unit))).toEqual(new Set(["ampoule"]));
    const sum = (k: string) => reg.filter((x) => x.kind === k).reduce((s, x) => s + x.qty, 0);
    expect([sum("received"), sum("given"), sum("reversal"), sum("wasted"), sum("returned")]).toEqual([4, 1, 0.5, 0.5, 2]);
    // On the ward: received − (given − reversed) − wasted − returned = one ampoule.
    expect(sum("received") - (sum("given") - sum("reversal")) - sum("wasted") - sum("returned")).toBe(1);
  });

  it("RED 7 — an infusion start or rate change needs the wristband and the bag's label", async () => {
    const r = await ready({ name: "Saline drip", stock: { form: "injection", strength: "1 g" }, drug: { dose: { value: 1, unit: "g" }, route: "iv", frequency: "OD" } });
    const base = { idempotencyKey: key(), orderId: r.orderId, rateMlPerHour: 100, at: H("09:00").toISOString() };
    expect(await refusal(recordInfusionEvent(db, w.nurse, { ...base, event: "start" }, { now: H("09:00") }))).toBe("wristband_scan_required");
    expect(await refusal(recordInfusionEvent(db, w.nurse, { ...base, idempotencyKey: key(), event: "start", patientCheck: { kind: "scan", wristbandCode: r.band } }, { now: H("09:00") }))).toBe("wrong_drug_scanned");
    await recordInfusionEvent(db, w.nurse, { ...base, idempotencyKey: key(), event: "start", patientCheck: { kind: "scan", wristbandCode: r.band }, labelCode: r.labelCode }, { now: H("09:00") });
    expect(await refusal(recordInfusionEvent(db, w.nurse, { ...base, idempotencyKey: key(), event: "rate_change", rateMlPerHour: 150, at: H("10:00").toISOString() }, { now: H("10:00") }))).toBe("wristband_scan_required");
    // YELLOW 9: an event stamped more than 2 minutes back is refused.
    expect(await refusal(recordInfusionEvent(db, w.nurse, { ...base, idempotencyKey: key(), event: "pause", at: H("10:00").toISOString() }, { now: H("10:03") }))).toBe("give_expired");
    // YELLOW 8: the order stops; the running infusion still stops.
    await stopIpOrder(db, w.consultant, { idempotencyKey: key(), orderId: r.orderId, reason: "Switched to oral" }, { now: H("11:00") });
    await recordInfusionEvent(db, w.nurse, { ...base, idempotencyKey: key(), event: "stop", at: H("11:05").toISOString() }, { now: H("11:05") });
  });

  it("YELLOW 10 — the PIN throttle is atomic: parallel wrong PINs get no more tries than the threshold", async () => {
    const r = await ready();
    const at = H("08:00");
    const tries = await Promise.allSettled(Array.from({ length: 12 }, () => proof(w.nurse, { ...w.pins.nurse2, pin: "0000" }, at, r.orderId, "high_alert_dose")));
    const checked = tries.filter((t) => t.status === "rejected" && (t.reason as IpdRefusal).detail?.throttled !== true);
    expect(checked.length).toBeLessThanOrEqual(5);
    expect(await refusal(proof(w.nurse, w.pins.nurse2, at, r.orderId, "high_alert_dose"))).toBe("second_nurse_not_confirmed");
  });

  it("YELLOW 11 / 12 — verify: no interaction data needs a note; an allergy needs a structured reason; never one's own order", async () => {
    const { admissionId, patientId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked("Zemox 250", { moiety: "Zemoxil" });
    await withTx(db, (tx) => addAllergy(tx, w.admitDesk, patientId, { substance: "Zemoxil", severity: "moderate", source: "consult" }));
    const o = await placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId, kind: "drug",
      drug: { itemId: med.medicineId, dose: { value: 500, unit: "mg" }, route: "oral", frequency: "TDS", startAt: T0.toISOString(), antibiotic: false, durationDays: 5, allergyOverrideReason: "Tolerated last year" },
    }, { now: T0 });
    const v = (extra: Record<string, unknown>) => verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: o.orderId, decision: "verified", checks: TICKS, ...extra }, { now: H("07:30") });
    expect(await refusal(v({}))).toBe("verify_note_required");
    expect(await refusal(v({ note: "Discussed" }))).toBe("allergy_override_required");
    expect(IPD_INTENTS.verify_order.input.safeParse({ idempotencyKey: key(), orderId: o.orderId, decision: "verified", checks: TICKS, allergyOverride: { reason: "because", text: "x" } }).success).toBe(false);
    // Never one's own order.
    await db.update(ipdOrders).set({ orderedBy: w.pharmacist.id }).where(eq(ipdOrders.id, o.orderId));
    expect(await refusal(v({ note: "Discussed", allergyOverride: { reason: "tolerated_before", text: "Took it in 2025" } }))).toBe("verify_own_order");
    await db.update(ipdOrders).set({ orderedBy: w.consultant.id }).where(eq(ipdOrders.id, o.orderId));
    await v({ note: "Discussed", allergyOverride: { reason: "tolerated_before", text: "Took it in 2025" } });
  });

  it("YELLOW 13 — a second issue needs its reason, and extra supply is capped at three a day", async () => {
    const r = await ready({ units: 3 });
    expect(await refusal(issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, units: 3, ownMedicine: false }, { now: H("08:00") }))).toBe("already_issued");
    for (let i = 0; i < 3; i += 1) {
      await issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, units: 3, ownMedicine: false, reissue: { reason: "extra_supply", note: "Top-up" } }, { now: H(`${String(8 + i).padStart(2, "0")}:00`) });
    }
    expect(await refusal(issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, units: 3, ownMedicine: false, reissue: { reason: "extra_supply", note: "Top-up" } }, { now: H("11:00") }))).toBe("reissue_limit");
  });

  it("YELLOW 14 — a bedside weight more than a tenth off sends the order back to the doctor", async () => {
    const r = await ready({ drug: { dose: { value: 10, unit: "mg" }, weightBasedPerKg: true, weightKg: 60 } });
    expect(await refusal(give(w.nurse, r, H("08:00"), H("08:00"), { weightKg: 70 }))).toBe("weight_changed_reverify");
    expect((await db.select().from(ipdOrders).where(eq(ipdOrders.id, r.orderId)))[0]!.verification).toBe("query");
    expect((await db.select().from(alerts).where(and(eq(alerts.userId, w.consultant.id), eq(alerts.kind, "ipd.emar.weight_changed")))).length).toBe(1);
  });

  it("YELLOW 15 / BLUE 25 — NPO: an oral dose needs the sips confirmation (counted); an OT NPO needs a doctor's OK; a lifted NPO needs nothing", async () => {
    const r = await ready({ units: 10, stripSize: 10 });
    const npo = (source: string, liftedAt: Date | null) => db.insert(dietNpo).values({
      id: newId(), patientId: r.patientId, admissionId: r.admissionId, startsAt: H("06:00"), endsAt: null, reason: "Test", source,
      setBy: w.nurse.id, setAt: H("06:00"), liftedAt, liftedBy: liftedAt === null ? null : w.nurse.id,
    } as never);
    await npo("doctor", H("07:00")); // lifted: not NPO
    await give(w.nurse, r, H("08:00"), H("08:00"));
    await db.execute(sql`delete from diet_npo where patient_id = ${r.patientId}`);
    await npo("doctor", null);
    expect(await refusal(give(w.nurse, r, H("14:00"), H("14:00")))).toBe("patient_npo");
    await give(w.nurse, r, H("14:00"), H("14:00"), { npoMeds: { kind: "sips_allowed", reason: "Dr allows meds with sips" } });
    expect((await readOverrideCounts(db, w.nurse, { now: H("15:00") })).byNurse.find((n) => n.userId === w.nurse.id)).toMatchObject({ npoOverrides: 1 });
    await db.execute(sql`delete from diet_npo where patient_id = ${r.patientId}`);
    await npo("ot_booking", null);
    expect(await refusal(give(w.nurse, r, H("20:00"), H("20:00"), { npoMeds: { kind: "sips_allowed", reason: "x" } }))).toBe("npo_doctor_ok_required");
    expect(await refusal(give(w.nurse, r, H("20:00"), H("20:00"), { npoMeds: { kind: "doctor_ok", doctorId: w.nurse2.id, readBack: true, reason: "x" } }))).toBe("verbal_doctor_invalid");
    await give(w.nurse, r, H("20:00"), H("20:00"), { npoMeds: { kind: "doctor_ok", doctorId: w.consultant.id, readBack: true, reason: "Anaesthetist: give with sip" } });
  });

  it("YELLOW 16 / 17 — no hold before the window opens; entered-in-error on a stopped order cancels the slot", async () => {
    const r = await ready();
    expect(await refusal(holdDose(db, w.nurse, { idempotencyKey: key(), orderId: r.orderId, doseDueAt: H("14:00").toISOString(), reason: "npo" }, { now: H("09:00") }))).toBe("outside_due_window");
    const g = await give(w.nurse, r, H("08:00"), H("08:00"));
    await stopIpOrder(db, w.consultant, { idempotencyKey: key(), orderId: r.orderId, reason: "Stop" }, { now: H("10:00") });
    await markDoseInError(db, w.nurse, { idempotencyKey: key(), actId: g.administrationId, kind: "entered_in_error", reason: "Wrong chart" }, { now: H("10:05") });
    expect((await db.select().from(ipdEmarDoses).where(and(eq(ipdEmarDoses.orderId, r.orderId), eq(ipdEmarDoses.dueAt, H("08:00")))))[0]!.status).toBe("cancelled");
  });

  it("YELLOW 18 / 19 — an allergy flag closes only after the doctor's decision; the prescriber is told; the backfill finds old ones", async () => {
    const r = await ready({ name: "Zemoxicillin 500", stock: { moiety: "Zemoxicillin" } });
    // A resident wrote it (not the duty doctor): the prescriber must be told too.
    await db.update(ipdOrders).set({ orderedBy: w.unitResident.id }).where(eq(ipdOrders.id, r.orderId));
    await withTx(db, (tx) => addAllergy(tx, w.admitDesk, r.patientId, { substance: "Zemoxicillin", severity: "severe", source: "consult" }));
    const ev = (await db.execute(sql`select * from events where name = 'allergy.recorded' and patient_id = ${r.patientId}`)).rows[0] as Record<string, unknown>;
    await emarAllergyConsumer(db)({ seq: Number(ev.seq), eventId: ev.event_id, name: ev.name, payload: ev.payload, patientId: ev.patient_id, correlationId: null, occurredAt: H("07:50") } as never);
    const flag = (await db.select().from(ipdEmarAllergyFlags).where(eq(ipdEmarAllergyFlags.orderId, r.orderId)))[0]!;
    expect((await db.select().from(alerts).where(eq(alerts.sourceEventId, `ipd.emar.allergy:${flag.id}`))).map((x) => x.userId)).toEqual(expect.arrayContaining([w.consultant.id, w.unitResident.id, w.pharmacist.id]));
    expect(await refusal(resolveAllergyFlag(db, w.pharmacist, { idempotencyKey: key(), flagId: flag.id, note: "ok" }, { now: H("08:00") }))).toBe("allergy_flag_undecided");
    await decideAllergyFlag(db, w.consultant, { idempotencyKey: key(), flagId: flag.id, decision: "continue", reason: "Mild rash only, benefit outweighs" }, { now: H("08:05") });
    await resolveAllergyFlag(db, w.pharmacist, { idempotencyKey: key(), flagId: flag.id, note: "Confirmed with Dr" }, { now: H("08:10") });
    // Backfill: an allergy written without its event (an import) is found once.
    const r2 = await ready({ name: "Quinox 500", stock: { moiety: "Quinoxol" } });
    await db.insert(patientAllergies).values({ id: newId(), patientId: r2.patientId, substance: "Quinoxol", severity: "mild", source: "consult", recordedBy: w.admitDesk.id, recordedAt: H("07:45") } as never);
    expect(await backfillEmarAllergyFlags(db, H("08:00"))).toBeGreaterThanOrEqual(1);
    expect(await backfillEmarAllergyFlags(db, H("08:01"))).toBe(0);
    // Decision STOP stops the order.
    const f2 = (await db.select().from(ipdEmarAllergyFlags).where(eq(ipdEmarAllergyFlags.orderId, r2.orderId)))[0]!;
    await decideAllergyFlag(db, w.consultant, { idempotencyKey: key(), flagId: f2.id, decision: "stop", reason: "Switch drug" }, { now: H("08:20") });
    expect((await db.select().from(ipdOrders).where(eq(ipdOrders.id, r2.orderId)))[0]!.status).toBe("stopped");
  });

  it("YELLOW 20 — the incident and its correction commit together or not at all", async () => {
    const r = await ready();
    const g = await give(w.nurse, r, H("08:00"), H("08:00"));
    await db.execute(sql.raw(`create function emar_test_fail() returns trigger language plpgsql as $$ begin if new.kind = 'medication_incident' then raise exception 'synthetic failure'; end if; return new; end $$`));
    await db.execute(sql.raw(`create trigger emar_test_fail before insert on ipd_emar_acts for each row execute function emar_test_fail()`));
    try {
      await expect(markDoseInError(db, w.nurse, { idempotencyKey: key(), actId: g.administrationId, kind: "medication_incident", reason: "Wrong dose", incident: { type: "wrong_dose", category: "C" } }, { now: H("08:10") })).rejects.toThrow(/synthetic failure/);
    } finally {
      await db.execute(sql.raw(`drop trigger emar_test_fail on ipd_emar_acts; drop function emar_test_fail()`));
    }
    expect(await db.select().from(pharmacyMedicationIncidents)).toHaveLength(0);
  });

  it("YELLOW 23 — a verbal order names an emergency from the list and a real doctor", async () => {
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked("Paracetamol IV", { form: "injection", strength: "1 g" });
    const body = (verbal: Record<string, unknown>) => ({
      idempotencyKey: key(), admissionId, kind: "drug",
      drug: { itemId: med.medicineId, dose: { value: 1, unit: "g" }, route: "iv", frequency: "STAT", startAt: T0.toISOString(), antibiotic: false, durationDays: 1 }, verbal,
    });
    expect(await refusal(placeIpOrder(db, w.nurse, body({ fromDoctorId: w.consultant.id, readBack: true, emergency: "doctor busy" }), { now: T0 }))).toBe("invalid_input");
    expect(await refusal(placeIpOrder(db, w.nurse, body({ fromDoctorId: w.nurse2.id, readBack: true, emergency: "severe_pain" }), { now: T0 }))).toBe("verbal_doctor_invalid");
    expect((await placeIpOrder(db, w.nurse, body({ fromDoctorId: w.consultant.id, readBack: true, emergency: "severe_pain" }), { now: T0 })).signBy).not.toBeNull();
  });

  it("BLUE 24 — an entered-in-error PRN give reopens its minute", async () => {
    const r = await ready({ drug: { frequency: "SOS", prn: { minIntervalMinutes: 240, max24h: 3 } } });
    const g = await give(w.nurse, r, H("08:00"), H("08:00"));
    await markDoseInError(db, w.nurse, { idempotencyKey: key(), actId: g.administrationId, kind: "entered_in_error", reason: "Wrong chart" }, { now: H("08:01") });
    await give(w.nurse, r, H("08:00"), H("08:00"), {});
    expect((await db.select().from(ipdEmarActs).where(and(eq(ipdEmarActs.orderId, r.orderId), eq(ipdEmarActs.kind, "given")))).length).toBe(2);
  });

  it("BLUE 27 — the verbal signature and the second-check spend are write-once; append-only tables refuse TRUNCATE", async () => {
    const r = await ready();
    await give(w.nurse, r, H("08:00"), H("08:00"));
    const p = await proof(w.nurse, w.pins.nurse2, H("08:00"), r.orderId, "high_alert_dose");
    await db.execute(sql`update ipd_emar_second_checks set used_at = now() where id = ${p.pinProof}`);
    await expect(db.execute(sql`update ipd_emar_second_checks set used_at = null where id = ${p.pinProof}`)).rejects.toThrow(/append_only/);
    await expect(db.execute(sql`update ipd_emar_second_checks set checker_id = ${w.nurse.id} where id = ${p.pinProof}`)).rejects.toThrow(/append_only/);
    await expect(db.execute(sql`delete from ipd_emar_second_checks where id = ${p.pinProof}`)).rejects.toThrow(/append_only/);
    for (const t of ["ipd_emar_acts", "ipd_emar_label_uses", "ipd_emar_narcotic_register", "ipd_emar_issues", "ipd_emar_verbal_orders", "ipd_emar_second_checks"]) {
      await expect(db.execute(sql.raw(`truncate table ${t} cascade`))).rejects.toThrow(/append_only/);
    }
    const { admissionId } = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked("Ondansetron IV", { form: "injection", strength: "4 mg" });
    const vo = await placeIpOrder(db, w.nurse, {
      idempotencyKey: key(), admissionId, kind: "drug",
      drug: { itemId: med.medicineId, dose: { value: 4, unit: "mg" }, route: "iv", frequency: "STAT", startAt: T0.toISOString(), antibiotic: false, durationDays: 1 },
      verbal: { fromDoctorId: w.consultant.id, readBack: true, emergency: "acute_deterioration" },
    }, { now: T0 });
    await expect(db.execute(sql`update ipd_emar_verbal_orders set emergency = 'other_emergency' where order_id = ${vo.orderId}`)).rejects.toThrow(/append_only/);
    await db.execute(sql`update ipd_emar_verbal_orders set signed_at = now(), signed_by = ${w.consultant.id} where order_id = ${vo.orderId}`);
    await expect(db.execute(sql`update ipd_emar_verbal_orders set signed_by = ${w.nurse.id} where order_id = ${vo.orderId}`)).rejects.toThrow(/append_only/);
  });

  it("BLUE 28 — more than five wristband overrides in 24 hours tell the ward in-charge", async () => {
    const supervisor = await mkUser(db, "emar.incharge", ["nursing_supervisor"]);
    const r = await ready({ units: 10, stripSize: 10, drug: { frequency: "SOS", prn: { minIntervalMinutes: 1, max24h: 10 } } });
    const over = (at: Date) => administerDose(db, w.nurse, {
      idempotencyKey: key(), orderId: r.orderId, doseDueAt: at.toISOString(), givenAt: at.toISOString(),
      patientCheck: { kind: "override", overrideReason: "band_unreadable", note: "Smudged" }, labelCode: r.labelCode,
    }, { now: at });
    for (let i = 0; i < 5; i += 1) await over(H(`0${String(8)}:${String(10 + i * 5)}`));
    expect((await db.select().from(alerts).where(and(eq(alerts.userId, supervisor.id), eq(alerts.kind, "ipd.emar.override_excess")))).length).toBe(0);
    await over(H("09:00"));
    await over(H("09:10"));
    expect((await db.select().from(alerts).where(and(eq(alerts.userId, supervisor.id), eq(alerts.kind, "ipd.emar.override_excess")))).length).toBe(1);
    void readEmarPatient;
  });
});
