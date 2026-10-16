import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ROLE_MODEL } from "../../../../scripts/seed-roles";
import { istDayString } from "../../../kernel/approvals/cumulative";
import { erBills, erChargeLines, invoices, ipdChargeLines, orders, patientDocuments } from "../../../kernel/db/schema";
import { newId } from "@hmis/contracts";
import { admit, planAdmission, takeDeposit } from "../../ipd";
import { serviceIdForLabCode } from "../../../../scripts/seed-lab-catalogue";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErBillWorld } from "../../../../test/helpers/emergency";
import {
  assignErDoctor, declareStabilised, dischargeFromEr, handToUnit, issueErMed, openMlc, placeErOrder, placeInBay, readErBoard, readErCare,
  readErEpisode, registerArrival, registerErChargeSink, registerErEncounterResolver, settleErBill, sweepErBoarding, takeErAdvance, triage,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErBillWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 6 (#813, decision 0076) — "DONE MEANS" FOR er-bill (spec SPEC-emergency-2026-10-15 §7). Every check calls the
 * INTENT functions; every instant is passed in. The ER tariff is the UAT SAMPLE fixture.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;
const PAPER = { signedBy: "patient" as const, method: "paper" as const, witnessName: "Desk Witness" };
const SUMMARY = {
  diagnosis: "Acute gastroenteritis", treatmentGiven: "IV fluids", medicines: [], returnIf: ["repeated_vomiting" as const],
};

describe("ER lane 6 er-bill — done means", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErBillWorld;
  const off: (() => void)[] = [];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErBillWorld(db);
    off.push(registerErEncounterResolver(), registerErChargeSink());
  });
  afterEach(() => { while (off.length > 0) off.pop()!(); });

  let n = 0;
  const seen = async (gate: Date, name?: string) => {
    n += 1;
    const p = await w.patient("female", 30 + n, name ?? `Bill Patient ${String(n)}`);
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", arrivedAt: gate.toISOString() }, { now: gate });
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 3, decision: { lifeSaving: false, highRisk: false, resources: "many", dangerVitals: false } }, { now: gate });
    const bay = await w.bed(`ER-BL${String(n)}`, { class: "emergency" });
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: bay }, { now: gate });
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, doctorId: w.erDoctor.id }, { now: gate });
    return a;
  };
  const cash = (amountPaise: number) => ({ tender: "cash" as const, amountPaise });

  it("(a) before 'stabilised' an advance or a settlement is refused; after it, allowed", async () => {
    const gate = new Date(Date.now() - 2 * 60 * MIN);
    const a = await seen(gate);
    await expect(takeErAdvance(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, tender: cash(50_000), payerName: "Son" }))
      .rejects.toMatchObject({ code: "not_stabilised" });
    await expect(settleErBill(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, settlement: "paid", tenders: [cash(70_000)] }))
      .rejects.toMatchObject({ code: "not_stabilised" });
    await declareStabilised(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId }, { now: new Date(gate.getTime() + 30 * MIN) });
    const adv = await takeErAdvance(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, tender: cash(50_000), payerName: "Son" });
    expect(adv.amountPaise).toBe(50_000);
    await dischargeFromEr(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, reason: "Better", summary: SUMMARY });
    // Registration ₹200 + physician ₹500 (sample); the advance ₹500 applied; ₹200 more in cash.
    const s = await settleErBill(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, settlement: "paid", tenders: [cash(20_000)] });
    expect(s).toMatchObject({ totalPaise: 70_000, patientPaise: 70_000, paidPaise: 70_000, duesPaise: 0 });
    expect(s.invoiceNo).not.toBeNull();
  });

  it("(b) a sexual-assault or acid-attack episode cannot carry a patient-payable line", async () => {
    const gate = new Date(Date.now() - 2 * 60 * MIN);
    const a = await seen(gate);
    await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, category: "sexual_assault" }, { now: gate });
    await declareStabilised(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId }, { now: new Date(gate.getTime() + 20 * MIN) });
    await expect(takeErAdvance(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, tender: cash(10_000), payerName: "Self" }))
      .rejects.toMatchObject({ code: "payer_pays_nothing" });
    await dischargeFromEr(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, reason: "Stable", summary: SUMMARY });
    await expect(settleErBill(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, settlement: "paid", tenders: [cash(70_000)] }))
      .rejects.toMatchObject({ code: "patient_payable_forbidden" });
    const s = await settleErBill(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, settlement: "nothing_payable" });
    expect(s).toMatchObject({ patientPaise: 0, payerPaise: 70_000, invoiceNo: null });
    expect(await db.select().from(invoices).where(eq(invoices.patientId, a.patientId))).toEqual([]);
  });

  it("(c) on admission every ER line — registration, physician, the drug, the test — is on the IP running bill with its ER date, once", async () => {
    const gate = new Date(Date.now() - 3 * 60 * MIN);
    const a = await seen(gate);
    const drug = await w.stocked("Ondansetron 4 mg");
    await issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, itemId: drug, doseWords: "4 mg", route: "iv", units: 2, orderedBy: w.erDoctor.id }, { now: new Date(gate.getTime() + 5 * MIN) });
    await placeErOrder(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, serviceIds: [serviceIdForLabCode("CBC")], indication: "Vomiting" }, { now: new Date(gate.getTime() + 6 * MIN), orderKinds: w.decls });
    const h = await handToUnit(db, w.erDoctor, {
      idempotencyKey: key(), episodeId: a.episodeId, reason: "Dehydration, needs ward", consultantId: w.doctor.id, requestedClass: "general", provisionalDiagnosis: "AGE",
    }, { now: new Date(gate.getTime() + 60 * MIN) });
    const t2 = new Date();
    const planned = await planAdmission(db, w.admitDesk, { idempotencyKey: key(), admissionId: h.admissionId, payerKind: "cash", requestedClass: "general", plan: { kind: "medical" } }, { now: t2 });
    const dep = planned.depositRequiredPaise > 0 ? await takeDeposit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId: h.admissionId, amountPaise: planned.depositRequiredPaise, tender: "cash", payer: { name: "Synthetic Payer", relation: "relative" },
    }, { now: t2 }) : null;
    await admit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId: h.admissionId, bedId: await w.bed("W-BL-1"), consent: PAPER,
      deposit: dep === null ? { exempt: "emergency_not_stabilised" } : { receiptId: dep.receiptId },
    }, { now: t2 });
    await sweepErBoarding(db, new Date(t2.getTime() + MIN));
    await sweepErBoarding(db, new Date(t2.getTime() + 2 * MIN));
    const ip = await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, h.admissionId));
    const day = istDayString(gate);
    const [o] = await db.select().from(orders).where(eq(orders.encounterNo, a.episodeNo));
    expect(ip.map((l) => [l.source, l.serviceCode, l.serviceDate]).sort()).toEqual([
      ["ipd.er", "ER-DRUG", day], ["ipd.er", "ER-PHYS", day], ["ipd.er", "ER-REG", day], ["ipd.order", expect.any(String), day],
    ].sort());
    expect(ip.find((l) => l.source === "ipd.order")!.orderId).toBe(o!.id);
    // The drug at its batch MRP: 2 vials × ₹50 (the fixture's batch).
    expect(ip.find((l) => l.serviceCode === "ER-DRUG")!.netPaise).toBe(10_000);
    expect((await db.select().from(erChargeLines).where(eq(erChargeLines.episodeId, a.episodeId))).every((l) => l.status === "moved")).toBe(true);
    await expect(settleErBill(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, settlement: "nothing_payable" }))
      .rejects.toMatchObject({ code: "rolled_to_ip" });
  });

  it("(d) a patient leaving with a balance is never held: dues against the undertaking, the invoice held — not credit", async () => {
    const gate = new Date(Date.now() - 2 * 60 * MIN);
    const a = await seen(gate);
    await declareStabilised(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId }, { now: new Date(gate.getTime() + 20 * MIN) });
    // Leaving needs nothing from the bill desk.
    await expect(dischargeFromEr(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, reason: "Better", summary: SUMMARY })).resolves.toMatchObject({ state: "departed" });
    await expect(settleErBill(db, w.billDesk, { idempotencyKey: key(), episodeId: a.episodeId, settlement: "dues", tenders: [cash(20_000)] }))
      .rejects.toMatchObject({ code: "undertaking_needed" });
    // ER review 3 (2026-10-15, DECIDED, IPD's rule): the undertaking is one of the patient's own filed documents.
    const documentId = newId();
    await db.insert(patientDocuments).values({
      id: documentId, patientId: a.patientId, kind: "outside_report", mimeType: "image/jpeg", byteSize: 10,
      storageKey: `2026/10/${documentId}.jpg`, sha256: "0".repeat(64), capturedBy: w.billDesk.id,
    });
    const s = await settleErBill(db, w.billDesk, {
      idempotencyKey: key(), episodeId: a.episodeId, settlement: "dues", tenders: [cash(20_000)],
      undertaking: { signerName: "Husband", relation: "husband", documentRef: "UT-ER-0001", documentId },
    });
    expect(s).toMatchObject({ patientPaise: 70_000, paidPaise: 20_000, duesPaise: 50_000 });
    const [inv] = await db.select().from(invoices).where(eq(invoices.patientId, a.patientId));
    expect(inv).toMatchObject({ creditExtended: false });
    expect((await db.select().from(erBills).where(eq(erBills.episodeId, a.episodeId)))[0]).toMatchObject({ settlement: "dues", undertaking: { documentRef: "UT-ER-0001" } });
  });

  it("(e) no ER doctor, nurse or board surface shows money, and no clinical role holds the bill desk's permission", async () => {
    const gate = new Date(Date.now() - 2 * 60 * MIN);
    const a = await seen(gate);
    await placeErOrder(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, serviceIds: [serviceIdForLabCode("CBC")], indication: "x" }, { now: gate, orderKinds: w.decls });
    const money = /paise|rupee|amount|₹|price|payable|dues|deposit|bill|advance/i;
    const surfaces = {
      care: await readErCare(db, w.erDoctor, a.episodeId),
      board: await readErBoard(db, w.erNurse),
      episode: await readErEpisode(db, w.erNurse, a.episodeId),
    };
    for (const [name, s] of Object.entries(surfaces)) {
      const keys = JSON.stringify(s).match(/"[A-Za-z_]+":/g) ?? [];
      expect([name, keys.filter((k) => money.test(k))]).toEqual([name, []]);
    }
    for (const role of ["doctor", "er_nurse"]) {
      expect([role, ROLE_MODEL.find((r) => r.roleKey === role)?.permissions.filter((p) => p === "er.bill")]).toEqual([role, []]);
    }
    expect(await db.select().from(erBills).where(and(eq(erBills.episodeId, a.episodeId)))).toEqual([]);
  });
});
