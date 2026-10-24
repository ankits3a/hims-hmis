import { randomUUID } from "node:crypto";
import { jsonWithoutIds } from "../../../../test/helpers/ids";
import { and, eq, inArray } from "drizzle-orm";
import { IPD_INTENTS, ipdSchemaKeys, newId } from "@hmis/contracts";
import {
  approvals, events, invoices, ipdAdmissions, patientDocuments, ipdChargeLines, ipdFinalBills, ipdMortuaryRegister, ipdTransfers, resourceStatusHistory, resources,
} from "../../../kernel/db/schema";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkDischargeWorld } from "../../../../test/helpers/ipd";
import {
  IpdRefusal, askDuesApproval, recordDuesApproval, confirmCharges, declareFit, issueGatePass, prepareFinalBill, receiveBody, recordAbscond, recordDeath,
  recordLama, releaseBody, reverseChargeLine, saveSummaryDraft, scanGatePass, settleFinalBill, signSummary, startTransfer,
  takeDeposit,
} from "../index";
import { readSummary } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { DischargeWorld } from "../../../../test/helpers/ipd";

/**
 * E3.2 (#730) — "DONE MEANS" FOR DISCHARGE (spec SPEC-ipd-core §6 "Discharge", §4.7; decision 0072). Every act is called
 * with an EXPLICIT instant (`{ now }`) written in IST; no test reads or pins the real clock. The fixture tariff prices
 * general: room ₹1,500, nursing ₹500, RMO ₹200 a day (`CHARGE_RATES`, GST-exempt category).
 */

jest.setTimeout(240_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();
const MONEY_WORDS = /paise|rupee|amount|fee|charge|dues|payable|price|deposit|bill/i;

async function refusal(p: Promise<unknown>): Promise<IpdRefusal> {
  try {
    await p;
  } catch (e) {
    if (e instanceof IpdRefusal) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("E3.2 discharge — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: DischargeWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkDischargeWorld(db); });

  const admission = async (id: string) => (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, id)))[0]!;
  const bed = async (id: string) => (await db.select().from(resources).where(eq(resources.id, id)))[0]!;
  const eventsNamed = async (name: string, admissionId: string) =>
    (await db.select().from(events).where(eq(events.name, name))).filter((e) => (e.payload as { admissionId?: string }).admissionId === admissionId);

  const fit = (admissionId: string, at: Date, disposition: "home" | "transfer_out" = "home") =>
    declareFit(db, w.doctor, { idempotencyKey: key(), admissionId, when: "today", disposition }, { now: at });
  const confirmAll = async (admissionId: string, at: Date) => {
    await confirmCharges(db, w.duty, { idempotencyKey: key(), admissionId, department: "ward" }, { now: at });
    await confirmCharges(db, w.cashier, { idempotencyKey: key(), admissionId, department: "billing" }, { now: at });
  };
  const signedSummary = async (admissionId: string, at: Date) => {
    const draft = await saveSummaryDraft(db, w.doctor, {
      idempotencyKey: key(), admissionId, expectedVersion: 0,
      content: { diagnosis: { text: "Community-acquired pneumonia" }, course: "Treated with antibiotics; improved.", medicines: [{ name: "Amoxicillin 500 mg", frequency: "TDS", duration: "5 days" }] },
    }, { now: at });
    return signSummary(db, w.doctor, { idempotencyKey: key(), admissionId, draftId: draft.summaryId, draftVersion: draft.version }, { now: at });
  };
  const settle = async (admissionId: string, at: Date, extra: Record<string, unknown> = {}) => {
    const bill = await prepareFinalBill(db, w.cashier, admissionId, { now: at });
    return settleFinalBill(db, w.cashier, { idempotencyKey: key(), admissionId, billVersion: bill.billVersion, patientPayablePaise: bill.patientPaise, settlement: "paid", payments: [], ...extra }, { now: at });
  };

  it("(i) discharge cannot complete while any department has not confirmed charges", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fit(admissionId, ist("2026-03-12T09:00:00"));
    await signedSummary(admissionId, ist("2026-03-12T09:10:00"));

    // Nobody has confirmed: the bill cannot settle and the gate pass refuses, naming who is silent.
    const prepared = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T09:20:00") });
    const settleEarly = await refusal(settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: prepared.billVersion, patientPayablePaise: prepared.patientPaise, settlement: "paid", payments: [{ tender: "cash", amountPaise: prepared.patientRoundedPaise }],
    }, { now: ist("2026-03-12T09:21:00") }));
    expect(settleEarly.code).toBe("charges_unconfirmed");
    expect(settleEarly.detail).toEqual({ pending: ["ward", "billing"] });
    const passEarly = await refusal(issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-12T09:22:00") }));
    expect(passEarly.code).toBe("charges_unconfirmed");

    // Billing confirms last: refused while the ward is still silent.
    const billingFirst = await refusal(confirmCharges(db, w.cashier, { idempotencyKey: key(), admissionId, department: "billing" }, { now: ist("2026-03-12T09:23:00") }));
    expect(billingFirst.code).toBe("charges_unconfirmed");
    expect(billingFirst.detail).toEqual({ pending: ["ward"] });
    // A department confirms only its own.
    expect((await refusal(confirmCharges(db, w.cashier, { idempotencyKey: key(), admissionId, department: "ward" }, { now: ist("2026-03-12T09:24:00") }))).code)
      .toBe("department_not_yours");

    await confirmCharges(db, w.duty, { idempotencyKey: key(), admissionId, department: "ward" }, { now: ist("2026-03-12T09:30:00") });
    // Ward done, billing still silent: still refused.
    expect((await refusal(issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-12T09:31:00") }))).detail)
      .toEqual({ pending: ["billing"] });
    const last = await confirmCharges(db, w.cashier, { idempotencyKey: key(), admissionId, department: "billing" }, { now: ist("2026-03-12T09:40:00") });
    expect(last).toMatchObject({ allConfirmed: true, pending: [] });

    const bill = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T09:45:00") });
    await settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: bill.billVersion, patientPayablePaise: bill.patientPaise, settlement: "paid", payments: [{ tender: "upi", amountPaise: bill.patientRoundedPaise, ref: "UPI-REF-9" }],
    }, { now: ist("2026-03-12T09:50:00") });
    const pass = await issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-12T10:00:00") });
    const scanned = await scanGatePass(db, w.admitDesk, { idempotencyKey: key(), gatePassCode: pass.code, gateId: newId(), scannedAt: ist("2026-03-12T10:20:00").toISOString() }, { now: ist("2026-03-12T10:20:00") });
    expect(scanned).toMatchObject({ admissionId, state: "discharged", bedStatus: "cleaning" });
    expect((await admission(admissionId)).state).toBe("discharged");
    expect(await eventsNamed("ipd.admission.discharged", admissionId)).toHaveLength(1);
    expect(await eventsNamed("ipd.gate_pass.scanned", admissionId)).toHaveLength(1);
  });

  it("(ii) a patient with unpaid dues is discharged through the approval path — never detained", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fit(admissionId, ist("2026-03-12T09:00:00"));
    await confirmAll(admissionId, ist("2026-03-12T09:10:00"));
    await signedSummary(admissionId, ist("2026-03-12T09:15:00"));
    const bill = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T09:20:00") });
    expect(bill.patientRoundedPaise).toBeGreaterThan(0);
    const part = 100_000;
    const dues = bill.patientRoundedPaise - part;

    // Unpaid without the signed undertaking: refused with the fix, not a dead end.
    const noUndertaking = await refusal(settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: bill.billVersion, patientPayablePaise: bill.patientPaise, settlement: "paid", payments: [{ tender: "cash", amountPaise: part }],
    }, { now: ist("2026-03-12T09:25:00") }));
    expect(noUndertaking.code).toBe("dues_need_approval");

    // Review #762 ⚖: the dues are recorded at once against the undertaking filed for this patient; the approval follows the exit.
    const undertakingDocumentId = newId();
    await db.insert(patientDocuments).values({
      id: undertakingDocumentId, patientId: (await admission(admissionId)).patientId, kind: "outside_report", mimeType: "image/jpeg", byteSize: 10,
      storageKey: `2026/03/${undertakingDocumentId}.jpg`, sha256: "0".repeat(64), capturedBy: w.cashier.id,
    });
    const settled = await settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: bill.billVersion, patientPayablePaise: bill.patientPaise, settlement: "dues_recorded",
      payments: [{ tender: "cash", amountPaise: part }], undertakingDocumentId,
    }, { now: ist("2026-03-12T09:40:00") });
    expect(settled).toMatchObject({ paidPaise: part, duesPaise: dues });

    // The invoice stays open on billing's dues list; it is NOT credit (billing's owner-only credit ruling untouched).
    const inv = (await db.select().from(invoices).where(eq(invoices.invoiceNo, settled.billNo)))[0]!;
    expect(inv.creditExtended).toBe(false);

    const pass = await issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId }, { now: ist("2026-03-12T09:45:00") });
    expect(pass.duesRecorded).toBe(true);
    await scanGatePass(db, w.duty, { idempotencyKey: key(), gatePassCode: pass.code, gateId: newId(), scannedAt: ist("2026-03-12T10:00:00").toISOString() }, { now: ist("2026-03-12T10:00:00") });
    expect((await admission(admissionId)).state).toBe("discharged");
    const row = (await db.select().from(ipdFinalBills).where(eq(ipdFinalBills.admissionId, admissionId)))[0]!;
    expect(row).toMatchObject({ duesPaise: dues, duesApprovalId: null, undertakingDocumentId });
    // After the exit: the billing manager approves the dues and the bill desk attaches it (a ledger step).
    const { approvalId } = await askDuesApproval(db, w.cashier, { admissionId, amountPaise: dues, note: "family will pay on Monday" });
    await approveRequest(db, w.billingManager, { approvalId, note: "undertaking signed" });
    await recordDuesApproval(db, w.cashier, { admissionId, approvalId }, { now: ist("2026-03-12T11:00:00") });
    const after = (await db.select().from(ipdFinalBills).where(eq(ipdFinalBills.admissionId, admissionId)))[0]!;
    expect(after).toMatchObject({ duesApprovalId: approvalId, duesApprovedBy: w.billingManager.id });
  });

  it("(iii) LAMA, absconded, death and transfer-out each end the stay, release the bed and emit their event once", async () => {
    // LAMA from admitted.
    const lama = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const lamaBed = (await w.openStay(lama.admissionId))!.bedId;
    const lamaIn = {
      idempotencyKey: key(), admissionId: lama.admissionId, kind: "lama", signedBy: "patient", risksExplainedBy: w.doctor.id,
      formDocumentId: newId(), witnessName: "Ward sister", at: ist("2026-03-11T15:00:00").toISOString(),
    };
    const lamaOut = await recordLama(db, w.doctor, lamaIn, { now: ist("2026-03-11T15:05:00") });
    await recordLama(db, w.doctor, lamaIn, { now: ist("2026-03-11T15:06:00") }); // a retried tap records once
    expect(lamaOut.state).toBe("lama");

    // Absconded (MLC needs the police intimation).
    const absc = await w.admitAt("general", ist("2026-03-10T11:00:00"));
    const abscBed = (await w.openStay(absc.admissionId))!.bedId;
    await db.update(ipdAdmissions).set({ mlc: true }).where(eq(ipdAdmissions.id, absc.admissionId));
    const abscBase = { admissionId: absc.admissionId, lastSeenAt: ist("2026-03-11T02:00:00").toISOString(), searchDone: true };
    expect((await refusal(recordAbscond(db, w.duty, { idempotencyKey: key(), ...abscBase }, { now: ist("2026-03-11T03:00:00") }))).code)
      .toBe("police_intimation_required");
    await recordAbscond(db, w.duty, { idempotencyKey: key(), ...abscBase, policeIntimationRef: "PS-1234" }, { now: ist("2026-03-11T03:05:00") });

    // Death mid-transfer: the open transfer and its hold are cancelled with the stay.
    const dead = await w.admitAt("general", ist("2026-03-10T12:00:00"));
    const deadBed = (await w.openStay(dead.admissionId))!.bedId;
    const target = await w.bed2("T-W2-D1");
    await startTransfer(db, w.sender, {
      idempotencyKey: key(), admissionId: dead.admissionId, toBedId: target, reason: "bed_management",
      handover: { situation: "s", background: "b", assessment: "a", recommendation: "r" },
    }, { now: ist("2026-03-11T08:00:00") });
    await recordDeath(db, w.doctor, {
      idempotencyKey: key(), admissionId: dead.admissionId, diedAt: ist("2026-03-11T08:30:00").toISOString(), certifiedBy: w.doctor.id,
      cause: { immediate: "Cardiac arrest" },
    }, { now: ist("2026-03-11T08:40:00") });
    const trf = (await db.select().from(ipdTransfers).where(eq(ipdTransfers.admissionId, dead.admissionId)))[0]!;
    expect(trf.status).toBe("cancelled");

    // Transfer out: refer to another hospital through the gate pass.
    const out = await w.admitAt("general", ist("2026-03-10T13:00:00"));
    const outBed = (await w.openStay(out.admissionId))!.bedId;
    await fit(out.admissionId, ist("2026-03-12T09:00:00"), "transfer_out");
    await confirmAll(out.admissionId, ist("2026-03-12T09:10:00"));
    await signedSummary(out.admissionId, ist("2026-03-12T09:15:00"));
    const b = await prepareFinalBill(db, w.cashier, out.admissionId, { now: ist("2026-03-12T09:20:00") });
    await settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId: out.admissionId, billVersion: b.billVersion, patientPayablePaise: b.patientPaise, settlement: "paid", payments: [{ tender: "card", amountPaise: b.patientRoundedPaise, ref: "CARD-REF-9" }],
    }, { now: ist("2026-03-12T09:25:00") });
    expect((await refusal(issueGatePass(db, w.cashier, { idempotencyKey: key(), admissionId: out.admissionId }, { now: ist("2026-03-12T09:30:00") }))).code)
      .toBe("receiving_hospital_missing");
    const pass = await issueGatePass(db, w.cashier, {
      idempotencyKey: key(), admissionId: out.admissionId, receivingHospital: { name: "District Hospital", confirmedBy: "Dr Sen by phone" },
    }, { now: ist("2026-03-12T09:35:00") });
    const scan = { idempotencyKey: key(), gatePassCode: pass.code, gateId: newId(), scannedAt: ist("2026-03-12T10:00:00").toISOString() };
    await scanGatePass(db, w.duty, scan, { now: ist("2026-03-12T10:00:00") });
    await scanGatePass(db, w.duty, scan, { now: ist("2026-03-12T10:01:00") }); // a double scan records once
    expect((await refusal(scanGatePass(db, w.duty, { ...scan, idempotencyKey: key() }, { now: ist("2026-03-12T10:02:00") }))).code).toBe("gate_pass_used");

    const cases: [string, string, string, string, boolean][] = [
      [lama.admissionId, lamaBed, "lama", "ipd.admission.lama", false],
      [absc.admissionId, abscBed, "absconded", "ipd.admission.absconded", true],
      [dead.admissionId, deadBed, "deceased", "ipd.admission.deceased", true],
      [out.admissionId, outBed, "transferred_out", "ipd.admission.discharged", false],
    ];
    for (const [id, bedId, state, event, terminal] of cases) {
      const a = await admission(id);
      expect([state, a.state, a.endedAt !== null]).toEqual([state, state, true]);
      expect([state, (await bed(bedId)).status, (await bed(bedId)).occupantRef]).toEqual([state, "cleaning", null]);
      const evs = await eventsNamed(event, id);
      expect([state, evs.length]).toEqual([state, 1]);
      if (state === "transferred_out") expect((evs[0]!.payload as { state: string }).state).toBe("transferred_out");
      // Death and abscond send the bed for a terminal clean (G3's vocabulary on the kernel release).
      const history = await db.select().from(resourceStatusHistory)
        .where(and(eq(resourceStatusHistory.resourceId, bedId), eq(resourceStatusHistory.toStatus, "cleaning")));
      expect([state, history.map((h) => h.reason)]).toEqual([state, [terminal ? "clean:terminal" : "clean:routine"]]);
    }
    // The hold the dead patient's transfer kept on the target bed is gone: the bed is free again.
    expect((await bed(target)).status).toBe("available");
  });

  it("(iv) death: the body is recorded in the mortuary register, and dues never block its release", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const death = await recordDeath(db, w.doctor, {
      idempotencyKey: key(), admissionId, diedAt: ist("2026-03-12T04:00:00").toISOString(), certifiedBy: w.doctor.id,
    }, { now: ist("2026-03-12T04:10:00") });
    const entry = (await db.select().from(ipdMortuaryRegister).where(eq(ipdMortuaryRegister.admissionId, admissionId)))[0]!;
    expect(entry).toMatchObject({ id: death.mortuaryEntryId, status: "expected", mlc: false });

    // The bill is not settled: charges stand unpaid on the stay.
    const bill = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T05:00:00") });
    expect(bill.patientRoundedPaise).toBeGreaterThan(0);
    expect(bill.settled).toBeNull();

    // Two-person identity check at the mortuary, then release to the next of kin — no bill consulted.
    expect((await receiveBody(db, w.duty, { idempotencyKey: key(), entryId: entry.id, identityCheckedBy: w.witness.id }, { now: ist("2026-03-12T05:10:00") })).status)
      .toBe("received");
    const released = await releaseBody(db, w.duty, {
      idempotencyKey: key(), entryId: entry.id, releasedTo: { name: "Ramesh Kumar", relation: "son", idProofRef: "XXXX-1234" },
    }, { now: ist("2026-03-12T08:00:00") });
    expect(released).toMatchObject({ status: "released", releasedTo: { relation: "son" } });
    // The dues are still there to be settled with the family — after, not as a condition.
    const later = await settleFinalBill(db, w.cashier, {
      idempotencyKey: key(), admissionId, billVersion: bill.billVersion, patientPayablePaise: bill.patientPaise, settlement: "paid", payments: [{ tender: "upi", amountPaise: bill.patientRoundedPaise, ref: "UPI-REF-9" }],
    }, { now: ist("2026-03-12T09:00:00") });
    expect(later.duesPaise).toBe(0);
  });

  it("(v) the summary's signed copy names the doctor and carries the draft model fields null", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await fit(admissionId, ist("2026-03-12T09:00:00"));
    const draft = await saveSummaryDraft(db, w.doctor, {
      idempotencyKey: key(), admissionId, expectedVersion: 0, content: { diagnosis: { text: "Dengue fever" } },
    }, { now: ist("2026-03-12T09:05:00") });
    expect(draft).toMatchObject({ status: "draft", label: "Draft", provenance: { draftModelId: null, draftPromptVersion: null, source: "person" } });

    // A resident's sign waits for the consultant's co-sign.
    const byResident = await signSummary(db, w.resident, { idempotencyKey: key(), admissionId, draftId: draft.summaryId, draftVersion: 1 }, { now: ist("2026-03-12T09:06:00") });
    expect(byResident.status).toBe("awaiting_cosign");
    // A stale version refuses.
    expect((await refusal(signSummary(db, w.doctor, { idempotencyKey: key(), admissionId, draftId: draft.summaryId, draftVersion: 2 }, { now: ist("2026-03-12T09:07:00") }))).code)
      .toBe("draft_changed");
    const signed = await signSummary(db, w.doctor, { idempotencyKey: key(), admissionId, draftId: draft.summaryId, draftVersion: 1 }, { now: ist("2026-03-12T09:08:00") });
    expect(signed).toMatchObject({ status: "signed", signedBy: w.doctor.id });

    const view = await readSummary(db, w.doctor, admissionId);
    expect(view).toMatchObject({
      status: "signed", label: "Signed", signedBy: { id: w.doctor.id, name: expect.any(String) },
      provenance: { draftModelId: null, draftPromptVersion: null },
    });
    expect(view.signedBy!.name.length).toBeGreaterThan(0);
    expect(view.documentId).toBe(signed.documentId);
  });

  it("(vi) the final invoice total is the sum of the non-reversed lines; the deposit is applied and the excess refunded", async () => {
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await db.update(ipdAdmissions).set({ payerKind: "cash", stabilisedAt: ist("2026-03-10T10:30:00") }).where(eq(ipdAdmissions.id, admissionId));
    const deposit = 500_000;
    await takeDeposit(db, w.admitDesk, {
      idempotencyKey: key(), admissionId, amountPaise: deposit, tender: "upi", tenderRef: "UPI-REF-1", payer: { name: "Self", relation: "self" },
    }, { now: ist("2026-03-10T11:00:00") });
    await fit(admissionId, ist("2026-03-12T09:00:00"));
    await confirmAll(admissionId, ist("2026-03-12T09:10:00"));
    const bill0 = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T09:20:00") });
    // Reverse one line: it and its reversal both drop out of the final bill.
    const lines = await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, admissionId));
    const rmo = lines.find((l) => l.component === "rmo")!;
    await reverseChargeLine(db, w.billDesk, { chargeLineId: rmo.id, reason: "RMO not posted that day" }, { now: ist("2026-03-12T09:25:00") });
    const after = await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, admissionId));
    const reversed = new Set(after.flatMap((l) => (l.reversalOf === null ? [] : [l.reversalOf])));
    const expected = after.filter((l) => l.reversalOf === null && !reversed.has(l.id)).reduce((s, l) => s + l.netPaise, 0);
    expect(expected).toBe(bill0.totalPaise - rmo.netPaise);

    // The old read is stale.
    expect((await refusal(settleFinalBill(db, w.cashier, { idempotencyKey: key(), admissionId, billVersion: bill0.billVersion, patientPayablePaise: bill0.patientPaise, settlement: "refund_due", payments: [] }, { now: ist("2026-03-12T09:30:00") }))).code)
      .toBe("bill_changed");
    const bill = await prepareFinalBill(db, w.cashier, admissionId, { now: ist("2026-03-12T09:31:00") });
    expect(bill.totalPaise).toBe(expected);
    const settled = await settleFinalBill(db, w.cashier, { idempotencyKey: key(), admissionId, billVersion: bill.billVersion, patientPayablePaise: bill.patientPaise, settlement: "refund_due", payments: [] }, { now: ist("2026-03-12T09:35:00") });

    const inv = (await db.select().from(invoices).where(eq(invoices.invoiceNo, settled.billNo)))[0]!;
    expect(inv.rawTotalPaise).toBe(expected);
    expect(settled).toMatchObject({ totalPaise: expected, patientPayablePaise: inv.netPayablePaise, paidPaise: 0, duesPaise: 0 });
    const row = (await db.select().from(ipdFinalBills).where(eq(ipdFinalBills.admissionId, admissionId)))[0]!;
    expect(row.depositAppliedPaise).toBe(inv.netPayablePaise);
    expect(row.refundPaise).toBe(deposit - inv.netPayablePaise);
    expect(settled.refundPaise).toBe(deposit - inv.netPayablePaise);
    const refund = (await db.select().from(approvals).where(eq(approvals.id, row.refundApprovalId!)))[0]!;
    expect([refund.patientId, refund.amountPaise, refund.status]).toEqual([patientId, deposit - inv.netPayablePaise, "pending"]);
  });

  it("(vii) declare_fit's answer carries no money (the doctor's act, decision 0058)", async () => {
    expect(ipdSchemaKeys(IPD_INTENTS.declare_fit.output).filter((k) => MONEY_WORDS.test(k))).toEqual([]);
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const out = await fit(admissionId, ist("2026-03-12T09:00:00"));
    expect(Object.keys(out).filter((k) => MONEY_WORDS.test(k))).toEqual([]);
    // #944 — the scans read past ids (#940): a random ULID can spell FEE, BILL or DUES by chance.
    expect(jsonWithoutIds(out)).not.toMatch(/paise|₹/i);
    expect(out).toEqual({
      admissionId, state: "fit_declared", clockStartedAt: ist("2026-03-12T09:00:00").toISOString(), targetAt: ist("2026-03-12T12:00:00").toISOString(),
    });
    const fitEvents = await db.select().from(events).where(and(eq(events.name, "ipd.discharge.fit_declared"), inArray(events.correlationId, [admissionId])));
    expect(fitEvents).toHaveLength(1);
    expect(jsonWithoutIds(fitEvents[0]!.payload)).not.toMatch(MONEY_WORDS);
  });
});
