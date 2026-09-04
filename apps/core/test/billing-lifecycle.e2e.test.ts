import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkDoctor, mkUser, seedOpdBase, seedOpdMasters, activateOpdVisitDefinition } from "./helpers/opd";
import { mkBillingManager, seedBillingBase } from "./helpers/billing";
import { events } from "../src/kernel/db/schema";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { patientsManifest } from "../src/modules/patients";
import { tariffManifest } from "../src/modules/tariff";
import { opdManifest } from "../src/modules/opd";
import { billingManifest, runDailyClose } from "../src/modules/billing";
import { istDay } from "../src/modules/billing/time";
import { CLEARANCE_APPROVAL_TYPE, CLEARANCE_APPROVAL_SUBJECT } from "../src/modules/billing/credit-notes";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { BillingBaseFixture } from "./helpers/billing";
import type { Db } from "../src/kernel/db/client";

/**
 * Plan 08 Task 12 — pipeline B's capstone. NO RED IS OWED (stated, per the plan and the §12
 * lesson): this file extends shipped surface (T1-T11 already ship and gate every mechanism it
 * drives) rather than introducing new behaviour, and an import-resolution red against a module
 * that already compiles would prove nothing about the story.
 *
 * ONE continuous story over HTTP, with exactly one disclosed exception: movement (8)'s
 * `runDailyClose` is invoked directly as a service call, per the plan's own Step 1 wording — the
 * sweep is UNSCHEDULED until Plan 11 and no route exists that CLAIMS a day (`GET /billing/day-book`
 * only ever reads the live numbers, never the `daily_closes` row). Every other movement rides real
 * HTTP against the composed app.
 *
 * There is deliberately no `beforeEach`/`truncateAll` between the nine movements: the whole file
 * shares ONE seed and ONE app instance, because the daily-close and GSTR-1 legs (8, 9) fold over
 * every receipt, invoice, credit note and voucher the earlier movements created THAT SAME service
 * day. Splitting the movements into isolated suites would make "the story's own numbers" a fiction.
 *
 * EVENT-SEQUENCE READING. Every assertion about an ORDERED sequence of events reads the `events`
 * table, never internal state. Where a document exists (an invoice), the read is scoped by
 * `(name, correlationId)` — the plan's own words. Session-lifecycle, standalone-receipt, recon and
 * daily-close events are NOT stamped with a correlationId by the shipped code (D1/D9/D7: an
 * advance has no invoice to correlate to, a session variance is neither patient- nor
 * payee-scoped) — those reads are scoped by `patientId` or `actorId` instead, which are the real
 * columns the shipped writer actually populated; this substitution is disclosed here rather than
 * silently claimed as a correlationId read.
 */

/** A complete, in-range adult reading — the opd.e2e fixture, so vitals move the encounter to `waiting`. */
const adultOk = { heightCm: 165, weightKg: 62, sbp: 118, dbp: 76, pulse: 72, rr: 16, spo2: 98, tempC: 36.8 };

/** Day-to-day counter work this story drives end to end. Deliberately narrower than "every billing
 * permission" — this file has no 403 sweep to justify granting the whole manifest (T11 owns that). */
const CASHIER_PERMISSIONS = [
  "billing.invoice.issue", "billing.invoice.read", "billing.credit.extend",
  "billing.receipt.record", "billing.credit_note.issue",
  "billing.refund.request", "billing.refund.pay",
  "billing.session.own", "billing.eie.mark", "billing.recon.upload", "billing.reports.read",
  // Filing the clearance-discount approval (movement 2) goes straight through the generic
  // approvals engine — there is no billing route that files it on the caller's behalf, unlike
  // the refund lane's `POST /billing/refunds/request`.
  "approvals.requests.create",
  "patients.register", "patients.read",
  "opd.visits.open", "opd.visits.read", "opd.vitals.record", "opd.queue.read",
];
const BILLING_MANAGER_PERMISSIONS = ["approvals.requests.read", "approvals.requests.decide"];
const DOC_PERMISSIONS = ["opd.consult", "opd.queue.read", "opd.queue.operate", "opd.visits.read", "patients.read"];

describe("billing lifecycle e2e", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(workflowManifest);
  registry.install(approvalsManifest);
  registry.install(patientsManifest);
  registry.install(tariffManifest);
  registry.install(opdManifest);
  registry.install(billingManifest);

  let base: BillingBaseFixture;
  let deptId: string;
  let roomId: string;
  let cashierA: { id: string; token: string };
  let manager: { id: string; token: string };
  let cashierB: { id: string; token: string };
  let dra: { doctorId: string; userId: string; token: string };

  beforeAll(async () => {
    // setupTestDb FIRST (it creates and MIGRATES this worker's database), then the per-worker
    // DATABASE_URL, and only then the module compile — AppModule's realtime tail reads
    // `select max(seq) from events` at boot (the opd.e2e / billing.e2e precedent).
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();

    await truncateAll(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    base = await seedBillingBase(db);

    for (const p of CASHIER_PERMISSIONS) await grantPermissionToRole(db, registry, "cashier", p);
    for (const p of BILLING_MANAGER_PERMISSIONS) await grantPermissionToRole(db, registry, "billing_manager", p);
    await createRole(db, "doc", "doc");
    for (const p of DOC_PERMISSIONS) await grantPermissionToRole(db, registry, "doc", p);

    // cashierA drives the counter across movements 1-4, 6-7 with ONE open session (never closed —
    // nothing in this story needs it closed). cashierA also carries `vitals_desk`: the OPD visit
    // workflow gates `registered -> waiting` on that role (the billing.e2e precedent).
    cashierA = await mkUser(db, "lifecycle_cashier", ["cashier", "vitals_desk"]);
    manager = await mkBillingManager(db, "lifecycle_manager");
    // cashierB holds BOTH "cashier" (billing.session.own, billing.receipt.record — the session
    // story's own counter work) AND "billing_manager" (approvals.requests.decide) — deliberately,
    // so the SAME actor who FILES the variance approval (beginClose files it as the acting
    // cashier, D9's free SoD) can also ATTEMPT to decide it: movement (5)'s whole point.
    cashierB = await mkUser(db, "lifecycle_session_cashier", ["cashier", "billing_manager"]);
    const doctor = await mkDoctor(db, {
      username: "lifecycle_doctor", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6],
    });
    await assignRole(db, { userId: doctor.userId, roleKey: "doc", scopeType: "hospital" });
    dra = doctor;

    // cashierA's own drawer, open for the whole file.
    await http().post("/billing/sessions").set(...auth(cashierA.token)).send({ floatPaise: 200_000 }).expect(201);
  });
  afterAll(async () => { await app.close(); await teardown(); });

  const http = () => request(app.getHttpServer());
  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];

  const registerPatient = async (name: string, phone: string): Promise<string> => {
    const reg = await http().post("/patients").set(...auth(cashierA.token))
      /*
        FD-8 CARRY-OVER — `acknowledgedDuplicates: true`, AND IT IS THE FIXTURE SAYING WHAT IT MEANS.

        `POST /patients` gained the walk-in's near-match warning in FD-8 (`1095d16`): it answers 409
        `duplicate_suspected` and hands back the candidates until the CLERK acknowledges them. This
        helper mints several patients whose only distinguishing field is a phone number, so from the
        second one onwards the route refused and three e2e suites went red at that commit —
        MEASURED here: green at `07b6902`, red at `4432335`, red before this line was added.

        The flag is the right fix and not a weakening. It is exactly what a human clerk sends after
        reading the warning, and this fixture IS that clerk: it means every patient it creates. The
        warning itself is covered where it belongs, in `patients.e2e.test.ts`, which FD-8 extended
        by 44 lines in the same commit — so acknowledging here removes no coverage of the guard.
      */
      .send({ name, sex: "female", phone, ageYears: 30, acknowledgedDuplicates: true }).expect(201);
    return reg.body.patient.id as string;
  };

  /** A walk-in `new` visit, moved to `waiting` by vitals — the state `startConsultation` needs. */
  const openVisit = async (patientId: string): Promise<string> => {
    const open = await http().post("/opd/visits").set(...auth(cashierA.token))
      .send({ patientId, departmentId: deptId, doctorId: dra.doctorId }).expect(201);
    const encounterId = open.body.encounter.id as string;
    expect(open.body.encounter.visitType).toBe("new");
    await http().post(`/opd/visits/${encounterId}/vitals`).set(...auth(cashierA.token)).send(adultOk).expect(201);
    return encounterId;
  };

  const eventsByCorrelation = async (correlationId: string): Promise<string[]> =>
    (
      await db.select({ name: events.name }).from(events)
        .where(eq(events.correlationId, correlationId)).orderBy(asc(events.seq))
    ).map((r) => r.name);

  const eventsByPatient = async (patientId: string): Promise<string[]> =>
    (
      await db.select({ name: events.name }).from(events)
        .where(eq(events.patientId, patientId)).orderBy(asc(events.seq))
    ).map((r) => r.name);

  const eventsByActor = async (actorId: string): Promise<string[]> =>
    (
      await db.select({ name: events.name }).from(events)
        .where(eq(events.actorId, actorId)).orderBy(asc(events.seq))
    ).map((r) => r.name);

  const eventCountByName = async (name: string): Promise<number> =>
    (await db.select({ name: events.name }).from(events).where(eq(events.name, name))).length;

  it("(1) new-visit pay -> consult: the gate refuses 409, the counter settles it, the doctor starts and completes", async () => {
    const p1 = await registerPatient("New Visit Patient", "9800000001");
    const encounterId = await openVisit(p1);

    const quote = await http().get(`/billing/visits/${encounterId}/fee-quote`).set(...auth(cashierA.token)).expect(200);
    expect(quote.body.free).toBe(false);
    expect(quote.body.visitType).toBe("new");
    expect(quote.body.feeServiceId).toBe(base.consultNewServiceId);
    // consultNew is EXEMPT-category and priced 50000 with no discount: no heads, no rounding.
    expect(quote.body.draft.totals.netPayablePaise).toBe(50_000);

    // D8, 409 per plan line 93 (d3074fa put `consult_gate_refused` into OPD_CONFLICT_CODES): an
    // unsettled fee is a STATE conflict, not a malformed request.
    const refused = await http().post(`/opd/visits/${encounterId}/consult/start`).set(...auth(dra.token)).expect(409);
    expect(refused.body.code).toBe("consult_gate_refused");
    expect(refused.body.detail.guard).toBe("billing_fee_gate");
    expect(refused.body.detail.code).toBe("fee_unsettled");

    const issued = await http().post("/billing/invoices").set(...auth(cashierA.token)).send({
      draftId: `d-${p1}-fee`, patientId: p1, encounterId,
      lines: [{ lineId: "fee", serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
    }).expect(201);
    const invoiceId = issued.body.invoiceId as string;
    expect(issued.body.settlement).toEqual({ state: "settled", outstandingPaise: 0 });

    const started = await http().post(`/opd/visits/${encounterId}/consult/start`).set(...auth(dra.token)).expect(201);
    expect(started.body.encounter.status).toBe("in_consultation");

    const completed = await http().post(`/opd/visits/${encounterId}/consult/complete`).set(...auth(dra.token))
      .send({ testsOrderedReturnToday: false }).expect(201);
    expect(completed.body.encounter.status).toBe("completed");

    // RC-1 T3 — settling a live token's consult fee also narrates the board flip, in the same
    // transaction and under the invoice's correlation (the `queue.fee_status_changed` hook).
    //
    // RC-3 T3 RENAMED THE EVENT, AND THIS PIN IS WHERE THE RENAME WAS INCOMPLETE. `fee_settled`
    // could only ever say the board had flipped ONE way; the three writers that move an encounter
    // back OUT of settled (`reverseAllocation`, `markEnteredInError`, `issueCreditNote`) reached no
    // hook at all, so a PAID stamp survived the money being reversed. The event now carries a
    // direction and the name says so.
    //
    // WHY THIS ONE LINE SURVIVED THE RENAME, recorded because it will happen again: RC-3 T3's
    // evidence batch was scoped to `billing`/`opd`/`membership`/`partners`, and this file is a
    // top-level `test/` e2e — one hop outside all four module paths. The pin was added by RC-1's
    // OWN close (`9bcc05f`) as "the one red in a 3268-test full pass", and then sat outside the next
    // lane's scope. §2.138's shape exactly: a census file in no task's Files list. Found by a peer
    // lane's full run, not by this one's.
    expect(await eventsByCorrelation(invoiceId)).toEqual(["invoice.issued", "receipt.recorded", "payment.received", "queue.fee_status_changed"]);
  });

  it("(2) the dues story: credit-extend -> dues list -> partial clear -> clearance discount under approval -> final clear -> settled", async () => {
    const p2 = await registerPatient("Dues Story Patient", "9800000002");

    // Generic (pharmacy, taxable 1200bps) service, gross 50000, no discount: taxHead(50000,1200)
    // = divHalfUp(60_000_000, 20_000) = floor((120_000_000+20_000)/40_000) = floor(3000.5) = 3000
    // per head. net = 50000 + 3000 + 3000 = 56000, already a whole rupee ⇒ rounding 0.
    const issued = await http().post("/billing/invoices").set(...auth(cashierA.token)).send({
      draftId: `d-${p2}-dues`, patientId: p2,
      lines: [{ lineId: "l1", serviceId: base.genericServiceId, qty: 1 }],
      credit: { reason: "the patient settles at the dues counter" },
    }).expect(201);
    const invoiceId = issued.body.invoiceId as string;
    expect(issued.body.creditExtended).toBe(true);
    expect(issued.body.settlement).toEqual({ state: "unpaid", outstandingPaise: 56_000 });

    const duesBefore = await http().get(`/billing/patients/${p2}/dues`).set(...auth(cashierA.token)).expect(200);
    expect(duesBefore.body.items).toHaveLength(1);
    expect(duesBefore.body.items[0].invoiceId).toBe(invoiceId);
    expect(duesBefore.body.items[0].outstandingPaise).toBe(56_000);

    // partial clear: 20000 of 56000.
    const r1 = await http().post("/billing/receipts").set(...auth(cashierA.token))
      .send({ patientId: p2, tenders: [{ mode: "cash", amountPaise: 20_000 }] }).expect(201);
    const partial = await http().post(`/billing/receipts/${r1.body.receiptId}/allocations`).set(...auth(cashierA.token))
      .send({ invoiceId, amountPaise: 20_000 }).expect(201);
    expect(partial.body.settlement).toEqual({ state: "partial", outstandingPaise: 36_000 });

    // clearance discount: ask 20000. cap = percentAmount(rawTotal 56000, maxBps 5000) =
    // divHalfUp(56000*5000, 10000) = floor((560_000_000+10_000)/20_000) = floor(28000.5) = 28000.
    // approval threshold = percentAmount(56000, approvalAboveBps 3000) = divHalfUp(168_000_000,
    // 10000) = floor((336_000_000+10_000)/20_000) = floor(16800.5) = 16800. 16800 < 20000 <=
    // 28000: under cap, but above the approval threshold.
    const refused = await http().post(`/billing/invoices/${invoiceId}/credit-notes`).set(...auth(cashierA.token))
      .send({ kind: "clearance_discount", reason: "goodwill at the dues counter", discountCategory: "charity", askPaise: 20_000 })
      .expect(409);
    expect(refused.body.code).toBe("clearance_approval_required");

    const filed = await http().post("/approvals").set(...auth(cashierA.token)).send({
      typeKey: CLEARANCE_APPROVAL_TYPE,
      subject: { type: CLEARANCE_APPROVAL_SUBJECT, id: invoiceId },
      patientId: p2,
      amountPaise: 20_000,
      requestNote: "clearance discount requested at the dues counter",
    }).expect(201);
    await http().post(`/approvals/${filed.body.approvalId}/approve`).set(...auth(manager.token))
      .send({ note: "goodwill approved" }).expect(201);

    const clearance = await http().post(`/billing/invoices/${invoiceId}/credit-notes`).set(...auth(cashierA.token))
      .send({
        kind: "clearance_discount", reason: "goodwill at the dues counter",
        discountCategory: "charity", askPaise: 20_000, approvalId: filed.body.approvalId as string,
      }).expect(201);
    expect(clearance.body.netPaise).toBe(20_000);
    expect(clearance.body.settlement).toEqual({ state: "partial", outstandingPaise: 16_000 });

    // final clear: the remaining 16000.
    const r2 = await http().post("/billing/receipts").set(...auth(cashierA.token))
      .send({ patientId: p2, tenders: [{ mode: "cash", amountPaise: 16_000 }] }).expect(201);
    const final = await http().post(`/billing/receipts/${r2.body.receiptId}/allocations`).set(...auth(cashierA.token))
      .send({ invoiceId, amountPaise: 16_000 }).expect(201);
    expect(final.body.settlement).toEqual({ state: "settled", outstandingPaise: 0 });

    const duesAfter = await http().get(`/billing/patients/${p2}/dues`).set(...auth(cashierA.token)).expect(200);
    expect(duesAfter.body.items).toEqual([]);

    // The whole dues story, read back from the events table by (name, correlationId=invoiceId) —
    // never from anything this test itself computed.
    expect(await eventsByCorrelation(invoiceId)).toEqual([
      "invoice.issued", "invoice.credit_extended",
      "payment.received", "credit_note.issued", "payment.received",
    ]);
  });

  it("(3) the advance story: a standalone receipt banks money, then applies to a later invoice", async () => {
    const p3 = await registerPatient("Advance Story Patient", "9800000003");

    const advance = await http().post("/billing/receipts").set(...auth(cashierA.token))
      .send({ patientId: p3, tenders: [{ mode: "cash", amountPaise: 80_000 }], note: "advance against a future visit" })
      .expect(201);
    expect(advance.body.totalPaise).toBe(80_000);

    const balanceBefore = await http().get(`/billing/patients/${p3}/balance`).set(...auth(cashierA.token)).expect(200);
    expect(balanceBefore.body.advancePaise).toBe(80_000);
    expect(balanceBefore.body.outstandingPaise).toBe(0);

    const later = await http().post("/billing/invoices").set(...auth(cashierA.token)).send({
      draftId: `d-${p3}-later`, patientId: p3,
      lines: [{ lineId: "l1", serviceId: base.consultNewServiceId, qty: 1 }],
      credit: { reason: "settled from the patient's own advance" },
    }).expect(201);
    const laterInvoiceId = later.body.invoiceId as string;
    expect(later.body.settlement).toEqual({ state: "unpaid", outstandingPaise: 50_000 });

    await http().post(`/billing/receipts/${advance.body.receiptId}/allocations`).set(...auth(cashierA.token))
      .send({ invoiceId: laterInvoiceId, amountPaise: 50_000 }).expect(201);

    const balanceAfter = await http().get(`/billing/patients/${p3}/balance`).set(...auth(cashierA.token)).expect(200);
    expect(balanceAfter.body.advancePaise).toBe(30_000);
    expect(balanceAfter.body.outstandingPaise).toBe(0);

    // Scoped by patientId, not correlationId: a standalone receipt has no invoice to correlate to
    // (D1) until the allocation below links it, so this IS the whole story's own event trail, in
    // the order it happened, read straight from the events table (`patient.registered` is the
    // patients module's own emission from `registerPatient` above, first by construction).
    expect(await eventsByPatient(p3)).toEqual([
      "patient.registered",
      "receipt.recorded", "advance.received", "invoice.issued", "invoice.credit_extended", "payment.received",
    ]);
  });

  it("(4) the refund story: credit note -> voucher request -> approve -> issue -> pay bank_transfer above threshold with payee identity", async () => {
    const p4 = await registerPatient("Refund Story Patient", "9800000004");

    // 25 units of the generic (pharmacy, 1200bps) service: gross 1_250_000, taxHead(1_250_000,
    // 1200) = divHalfUp(1_500_000_000, 20_000) = floor((3_000_000_000+20_000)/40_000) =
    // floor(75000.5) = 75000 per head. net = 1_250_000 + 75_000 + 75_000 = 1_400_000, whole rupees.
    const issued = await http().post("/billing/invoices").set(...auth(cashierA.token)).send({
      draftId: `d-${p4}-refund`, patientId: p4,
      lines: [{ lineId: "l1", serviceId: base.genericServiceId, qty: 25 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 1_400_000 }] },
    }).expect(201);
    const invoiceId = issued.body.invoiceId as string;
    expect(issued.body.settlement).toEqual({ state: "settled", outstandingPaise: 0 });

    const detail = await http().get(`/billing/invoices/${invoiceId}`).set(...auth(cashierA.token)).expect(200);
    const invoiceLineId = detail.body.lines[0].id as string;

    const note = await http().post(`/billing/invoices/${invoiceId}/credit-notes`).set(...auth(cashierA.token))
      .send({ kind: "refund", reason: "the ordered pack was never dispensed", lines: [{ invoiceLineId, qty: 25 }] })
      .expect(201);
    expect(note.body.netPaise).toBe(1_400_000);
    const creditNoteId = note.body.creditNoteId as string;

    // 1_400_000p > refundBankAbovePaise (1_000_000p): the counter issues it as bank_transfer up
    // front, since a cash voucher this large could never legally be paid out (D6/refunds.ts).
    const requested = await http().post("/billing/refunds/request").set(...auth(cashierA.token)).send({
      kind: "invoice_refund", creditNoteId, amountPaise: 1_400_000,
      reasonClass: "genuine", reason: "pack never dispensed, patient discharged against advice",
    }).expect(201);
    const approvalId = requested.body.approvalId as string;

    await http().post(`/approvals/${approvalId}/approve`).set(...auth(manager.token))
      .send({ note: "refund approved, over the bank-transfer floor" }).expect(201);

    const voucher = await http().post("/billing/refunds").set(...auth(cashierA.token)).send({
      kind: "invoice_refund", creditNoteId, amountPaise: 1_400_000,
      reasonClass: "genuine", reason: "pack never dispensed, patient discharged against advice",
      approvalId, method: "bank_transfer",
    }).expect(201);
    expect(voucher.body.status).toBe("issued");

    const paid = await http().post(`/billing/refunds/${voucher.body.voucherId}/pay`).set(...auth(cashierA.token)).send({
      payeeName: "Refund Story Patient", payeeIdType: "aadhaar", payeeIdRef: "XXXX-9004",
    }).expect(201);
    expect(paid.body.status).toBe("paid");
    expect(paid.body.method).toBe("bank_transfer");

    expect(await eventsByCorrelation(invoiceId)).toEqual([
      "invoice.issued", "receipt.recorded", "payment.received",
      "credit_note.issued", "refund_voucher.issued", "payment.refunded",
    ]);
  });

  it("(5) the session story: open -> collect -> close with variance -> SoD refusal on self-approval -> manager approves -> confirm", async () => {
    const open = await http().post("/billing/sessions").set(...auth(cashierB.token)).send({ floatPaise: 200_000 }).expect(201);
    const sessionId = open.body.id as string;

    const p5 = await registerPatient("Session Story Patient", "9800000005");
    const collect = await http().post("/billing/receipts").set(...auth(cashierB.token))
      .send({ patientId: p5, tenders: [{ mode: "cash", amountPaise: 100_000 }], note: "collected mid-session" }).expect(201);
    expect(collect.body.totalPaise).toBe(100_000);

    // expectedCashPaise = openingFloat(200000) + this session's cash tenders(100000) - cash
    // vouchers paid(0) = 300000. counted: 1x2000-rupee note + 3x500-rupee notes = 200000 + 150000
    // = 350000 paise -> variance +50000 (the drawer is over).
    const closing = await http().post(`/billing/sessions/${sessionId}/close`).set(...auth(cashierB.token))
      .send({ denominations: { "200000": 1, "50000": 3 }, note: "drawer over by five hundred rupees" }).expect(201);
    expect(closing.body.status).toBe("closing");
    expect(closing.body.countedCashPaise).toBe(350_000);
    expect(closing.body.expectedCashPaise).toBe(300_000);
    expect(closing.body.variancePaise).toBe(50_000);
    const approvalId = closing.body.varianceApprovalId as string;
    expect(approvalId).toEqual(expect.any(String));

    // SoD refusal: cashierB FILED this approval (beginClose files it as the acting cashier — D9's
    // free SoD) and now tries to decide it themself. Asserts an SoD-SPECIFIC signal, never a bare
    // status code (a permission-less caller would ALSO get 403 on this exact route): the message
    // names the seeded pair, and the sod.violation_blocked event is read back from the events
    // table, not inferred from the HTTP status alone.
    const selfApprove = await http().post(`/approvals/${approvalId}/approve`).set(...auth(cashierB.token))
      .send({ note: "trying to approve my own variance" }).expect(403);
    expect(selfApprove.body.message).toContain("requester_approver");

    await http().post(`/approvals/${approvalId}/approve`).set(...auth(manager.token))
      .send({ note: "counted with the cashier, over by five hundred rupees" }).expect(201);

    const closed = await http().post(`/billing/sessions/${sessionId}/confirm-close`).set(...auth(cashierB.token)).expect(201);
    expect(closed.body.status).toBe("closed");

    // Scoped by actorId, not correlationId: session-lifecycle and variance events carry neither a
    // patientId nor a correlationId (D9 — a variance is signed and belongs to no patient), so this
    // reads the whole session story back in the order it happened, by the one column the shipped
    // writer DID populate on every one of these rows — the acting cashier. `approval.requested` is
    // the kernel's own emission from `requestApproval`, filed by cashierB inside `beginClose`.
    expect(await eventsByActor(cashierB.id)).toEqual([
      "cashier_session.opened", "receipt.recorded", "advance.received",
      "variance.flagged", "approval.requested", "sod.violation_blocked", "cashier_session.closed",
    ]);
  });

  it("(6) the EIE story: marking a receipt reverses its allocations and the invoice returns to unpaid", async () => {
    const p6 = await registerPatient("EIE Story Patient", "9800000006");

    const issued = await http().post("/billing/invoices").set(...auth(cashierA.token)).send({
      draftId: `d-${p6}-eie`, patientId: p6,
      lines: [{ lineId: "l1", serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
    }).expect(201);
    const invoiceId = issued.body.invoiceId as string;
    const receiptId = issued.body.receiptId as string;
    expect(issued.body.settlement).toEqual({ state: "settled", outstandingPaise: 0 });

    const eie = await http().post("/billing/eie").set(...auth(cashierA.token))
      .send({ receiptId, reason: "double-keyed at the counter, the patient never actually paid" }).expect(201);
    expect(eie.body.reversedAllocationIds).toHaveLength(1);

    const after = await http().get(`/billing/invoices/${invoiceId}`).set(...auth(cashierA.token)).expect(200);
    expect(after.body.settlement).toEqual({ state: "unpaid", outstandingPaise: 50_000 });

    // The invoice itself was never marked entered-in-error — only its receipt was — so it still
    // carries every event up to and including the reversal the mark triggered.
    expect(await eventsByCorrelation(invoiceId)).toEqual([
      "invoice.issued", "receipt.recorded", "payment.received", "allocation.reversed",
    ]);
  });

  it("(7) the recon story: a statement upload reconciles one tender and mismatches another", async () => {
    const p7a = await registerPatient("Recon Story Patient A", "9800000007");
    const p7b = await registerPatient("Recon Story Patient B", "9800000107");

    const okInvoice = await http().post("/billing/invoices").set(...auth(cashierA.token)).send({
      draftId: `d-${p7a}-recon`, patientId: p7a,
      lines: [{ lineId: "l1", serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "upi", amountPaise: 50_000, refText: "UPI-OK-1" }] },
    }).expect(201);
    expect(okInvoice.body.settlement).toEqual({ state: "settled", outstandingPaise: 0 });

    // Card fee 150bps: percentAmount(50000,150) = divHalfUp(7_500_000,10000) =
    // floor((15_000_000+10_000)/20_000) = floor(750.5) = 750; expected net = 50000-750 = 49250,
    // stamped at CAPTURE (T5), never recomputed at recon time.
    const badInvoice = await http().post("/billing/invoices").set(...auth(cashierA.token)).send({
      draftId: `d-${p7b}-recon`, patientId: p7b,
      lines: [{ lineId: "l1", serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "card", amountPaise: 50_000, refText: "CARD-BAD-1" }] },
    }).expect(201);
    expect(badInvoice.body.settlement).toEqual({ state: "settled", outstandingPaise: 0 });

    const day = istDay(new Date());
    const upload = await http().post("/billing/recon/upload").set(...auth(cashierA.token)).send({
      source: "card",
      csv: `ref,settledPaise,settledOn\nUPI-OK-1,50000,${day}\nCARD-BAD-1,45000,${day}`,
    }).expect(201);
    expect(upload.body.rowsTotal).toBe(2);
    expect(upload.body.rowsMatched).toBe(1);
    expect(upload.body.rowsMismatched).toBe(1);
    expect(upload.body.unmatchedRefs).toEqual([]);

    const mismatches = await http().get("/billing/recon/mismatches").set(...auth(cashierA.token)).expect(200);
    expect(mismatches.body.items).toHaveLength(1);
    expect(mismatches.body.items[0].expectedNetPaise).toBe(49_250);
    expect(mismatches.body.items[0].settledPaise).toBe(45_000);

    // Scoped by patientId: tender.reconciled/tender.mismatched carry no correlationId (D7 — a
    // tender's document is the receipt, and the events already read this way elsewhere in this
    // file for standalone receipts). `patient.registered` is the patients module's own emission
    // from `registerPatient` above.
    expect(await eventsByPatient(p7a)).toEqual([
      "patient.registered", "invoice.issued", "receipt.recorded", "payment.received", "tender.reconciled",
    ]);
    expect(await eventsByPatient(p7b)).toEqual([
      "patient.registered", "invoice.issued", "receipt.recorded", "payment.received", "tender.mismatched",
    ]);
  });

  it("(8) the daily close: runDailyClose invoked directly (unscheduled), totals hand-summed from the story's own numbers", async () => {
    const day = istDay(new Date());

    // Every receipt/invoice/credit-note/voucher this file created lands on TODAY's service day —
    // nothing pins a different date. Hand-summed from the story's own numbers, never from what any
    // earlier assertion printed:
    //
    // RECEIPTS (9 rows created across movements 1-7, 1 entered-in-error and excluded):
    //   #1 cash    50,000  (movement 1, inline with invoice #1)
    //   #2 cash    20,000  (movement 2, partial clear)
    //   #3 cash    16,000  (movement 2, final clear)
    //   #4 cash    80,000  (movement 3, standalone advance)
    //   #5 cash 1,400,000  (movement 4, inline with invoice #4)
    //   #6 cash   100,000  (movement 5, mid-session collect)
    //   #7 cash    50,000  (movement 6, inline with invoice #5) -- ENTERED IN ERROR, excluded
    //   #8 upi     50,000  (movement 7, invoice A)
    //   #9 card    50,000  (movement 7, invoice B)
    //   live count = 8 (all but #7)
    //   cash = 50,000+20,000+16,000+80,000+1,400,000+100,000 = 1,666,000
    //   upi = 50,000; card = 50,000; grand total = 1,766,000
    //
    // INVOICES (7; only the movement-6 RECEIPT was entered-in-error, never the invoice, so all 7
    // invoices still count):
    //   #1 50,000  #2 56,000  #3 50,000  #4 1,400,000  #5 50,000  #6 50,000  #7 50,000
    //   sum = 50,000+56,000+50,000+1,400,000+50,000+50,000+50,000 = 1,706,000
    //
    // CREDIT NOTES (2): movement 2's clearance discount 20,000 + movement 4's full refund
    // 1,400,000 -- sum = 1,420,000
    //
    // VOUCHERS PAID (1): the movement-4 refund, 1,400,000
    const first = await runDailyClose(db, day);
    expect(first.claimed).toBe(true);
    // The only OPD visit this file opened (movement 1) already carries a settled fee invoice.
    expect(first.orphans).toEqual([]);
    expect(first.totals).toEqual({
      day,
      receipts: { count: 8, totalPaise: 1_766_000, byMode: { cash: 1_666_000, upi: 50_000, card: 50_000 } },
      degraded: { count: 0, totalPaise: 0 },
      invoices: { count: 7, netPayablePaise: 1_706_000 },
      creditNotes: { count: 2, netPaise: 1_420_000 },
      vouchersPaid: { count: 1, amountPaise: 1_400_000 },
    });

    // Idempotent: the claim is `ON CONFLICT DO NOTHING` inside the same tx as the events it
    // authorises (D9) — a second run the same day claims nothing and appends nothing new.
    const second = await runDailyClose(db, day);
    expect(second.claimed).toBe(false);
    expect(second.totals).toEqual(first.totals);
    expect(await eventCountByName("day.closed")).toBe(1);
  });

  it("(9) GSTR-1 over the story's own invoices matches hand-derived heads", async () => {
    const day = istDay(new Date());
    const gstr1 = await http().get("/billing/gstr1").query({ from: day, to: day }).set(...auth(cashierA.token)).expect(200);

    // Two SAC/rate groups; buyerGstin is null throughout (nobody in this story supplied one, so
    // both rows land in the B2C bucket):
    //
    // PHARMACY (sac 3004, 1200bps, taxable): invoice #2's line (base 50,000, cgst/sgst 3,000 each)
    // PLUS invoice #4's line (base 1,250,000, cgst/sgst 75,000 each) BEFORE netting, minus the
    // movement-4 credit note's FULL refund of that exact line (25 of 25 units, so the share is the
    // whole line, not a fraction): 1,300,000-1,250,000=50,000 base; 78,000-75,000=3,000 per head --
    // leaving exactly invoice #2's own line. Movement 2's clearance-discount credit note carries NO
    // invoice_line rows at all (D4: the clearance lane adjusts value, not a specific taxable line)
    // and nets out nothing here.
    //
    // CONSULTATION (sac 999312, 1800bps, EXEMPT): five qty-1 lines at 50,000 base and no tax --
    // invoices #1, #3, #5, #6, #7 (movements 1, 3, 6, 7x2) -- 5 x 50,000 = 250,000 base, 0 cgst,
    // 0 sgst.
    //
    // gstr1Order sorts B2C rows by sacCode, field by field: "3004" < "999312".
    expect(gstr1.body.rows).toEqual([
      { buyerGstin: null, sacCode: "3004", rateBps: 1200, exempt: false, taxableBasePaise: 50_000, cgstPaise: 3_000, sgstPaise: 3_000 },
      { buyerGstin: null, sacCode: "999312", rateBps: 1800, exempt: true, taxableBasePaise: 250_000, cgstPaise: 0, sgstPaise: 0 },
    ]);
  });
});
