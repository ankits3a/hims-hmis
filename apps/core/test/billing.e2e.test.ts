import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkDoctor, mkUser, seedOpdBase, seedOpdMasters, activateOpdVisitDefinition } from "./helpers/opd";
import { mkBillingManager, mkCashier, seedBillingBase } from "./helpers/billing";
import { billingConfig, events } from "../src/kernel/db/schema";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { DEFAULT_LETTERHEAD } from "../src/modules/opd/config";
import { authManifest } from "../src/kernel/auth/manifest";
import { workflowManifest } from "../src/kernel/workflow/manifest";
import { approvalsManifest } from "../src/kernel/approvals/manifest";
import { patientsManifest } from "../src/modules/patients";
import { tariffManifest } from "../src/modules/tariff";
import { opdManifest } from "../src/modules/opd";
import { billingManifest } from "../src/modules/billing";
import { istDay } from "../src/modules/billing/time";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { requireEnv } from "../src/kernel/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { BillingBaseFixture } from "./helpers/billing";
import type { Db } from "../src/kernel/db/client";

/**
 * Plan 08 Task 11 — the wire contract over REAL HTTP.
 *
 * THE ROUTE TABLE IS THE CONTRACT. It is transcribed here from the plan's Task 11 Step 1 and the
 * 403 sweep iterates it, so a dropped or renamed route fails by COUNT and by NAME rather than
 * quietly disappearing. This file was written RED-FIRST against this table: before
 * `billing.controller.ts` existed every one of the 31 entries answered 404 instead of 403.
 *
 * The load-bearing leg is test 2. T10's own gate test registers the guard BY HAND, so this suite
 * is the only place the module-init registration in `billing.module.ts` is exercised: an unpaid
 * `new` visit is refused at `/opd/.../consult/start` with 409 `consult_gate_refused`, the fee is
 * taken through the billing routes, and the retry starts 201 — all through the composed app.
 */
const ROUTES: [method: "get" | "post" | "put", path: string][] = [
  ["post", "/billing/invoices"],
  ["post", "/billing/invoices/preview"],
  ["get", "/billing/invoices"],
  ["get", "/billing/invoices/X"],
  ["get", "/billing/invoices/X/print"],
  ["post", "/billing/invoices/X/credit-notes"],
  ["get", "/billing/invoices/X/credit-notes"],
  ["get", "/billing/visits/X/fee-quote"],
  ["post", "/billing/receipts"],
  ["get", "/billing/receipts"],
  ["post", "/billing/receipts/X/allocations"],
  ["post", "/billing/allocations/X/reverse"],
  ["post", "/billing/eie"],
  ["get", "/billing/patients/X/balance"],
  ["get", "/billing/patients/X/dues"],
  ["post", "/billing/refunds/request"],
  ["post", "/billing/refunds"],
  ["post", "/billing/refunds/X/pay"],
  ["get", "/billing/refunds"],
  ["post", "/billing/sessions"],
  ["get", "/billing/sessions/current"],
  ["post", "/billing/sessions/X/close"],
  ["post", "/billing/sessions/X/confirm-close"],
  ["get", "/billing/sessions"],
  ["post", "/billing/recon/upload"],
  ["get", "/billing/recon/mismatches"],
  ["get", "/billing/day-book"],
  ["get", "/billing/gstr1"],
  ["get", "/billing/config"],
  ["put", "/billing/config"],
  ["put", "/billing/degraded"],
];

/** A complete, in-range adult reading — the opd.e2e fixture, so vitals move the encounter to `waiting`. */
const adultOk = { heightCm: 165, weightKg: 62, sbp: 118, dbp: 76, pulse: 72, rr: 16, spo2: 98, tempC: 36.8 };

/** The fourteen manifest permissions, granted whole to the counter role: one cashier drives every lane. */
const COUNTER_PERMISSIONS = [
  "billing.invoice.issue", "billing.invoice.read", "billing.credit.extend",
  "billing.receipt.record", "billing.allocation.reverse", "billing.credit_note.issue",
  "billing.refund.request", "billing.refund.pay",
  "billing.session.own", "billing.session.read",
  "billing.recon.upload", "billing.reports.read", "billing.config.write", "billing.eie.mark",
  "patients.register", "patients.read",
  "opd.visits.open", "opd.visits.read", "opd.vitals.record", "opd.queue.read",
];

describe("billing e2e", () => {
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
  let cashier: { id: string; token: string };
  let cashier2: { id: string; token: string };
  let manager: { id: string; token: string };
  let rando: { id: string; token: string };
  let dra: { doctorId: string; userId: string; token: string };

  beforeAll(async () => {
    // setupTestDb FIRST (it creates and MIGRATES this worker's database), then the per-worker
    // DATABASE_URL, and only then the module compile — AppModule's realtime tail reads
    // `select max(seq) from events` at boot. The opd.e2e precedent.
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  });
  afterAll(async () => { await app.close(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    base = await seedBillingBase(db);

    for (const p of COUNTER_PERMISSIONS) await grantPermissionToRole(db, registry, "cashier", p);
    for (const p of ["approvals.requests.read", "approvals.requests.decide"]) {
      await grantPermissionToRole(db, registry, "billing_manager", p);
    }
    await createRole(db, "doc", "doc");
    for (const p of ["opd.consult", "opd.queue.read", "opd.queue.operate", "opd.visits.read", "patients.read"]) {
      await grantPermissionToRole(db, registry, "doc", p);
    }

    // The counter cashier also carries `vitals_desk`: the OPD visit workflow gates
    // `registered → waiting` on that role (workflow-def.ts:28) and this suite drives a walk-in to
    // `waiting` over HTTP before the doctor's consult start.
    cashier = await mkUser(db, "counter_cashier", ["cashier", "vitals_desk"]);
    cashier2 = await mkCashier(db, "other_cashier");
    manager = await mkBillingManager(db, "counter_manager");
    // A live session with NO role at all: the sweep must prove the ROUTES refuse, not that an
    // unauthenticated request 401s.
    rando = await mkUser(db, "rando_no_perms", []);
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    await assignRole(db, { userId: dra.userId, roleKey: "doc", scopeType: "hospital" });
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];

  const registerPatient = async (name: string, phone: string): Promise<string> => {
    const reg = await http().post("/patients").set(...auth(cashier.token))
      .send({ name, sex: "female", phone, ageYears: 30 }).expect(201);
    return reg.body.patient.id as string;
  };

  /** A walk-in `new` visit, moved to `waiting` by vitals — the state `startConsultation` needs. */
  const openVisit = async (patientId: string): Promise<string> => {
    const open = await http().post("/opd/visits").set(...auth(cashier.token))
      .send({ patientId, departmentId: deptId, doctorId: dra.doctorId }).expect(201);
    const encounterId = open.body.encounter.id as string;
    expect(open.body.encounter.visitType).toBe("new");
    await http().post(`/opd/visits/${encounterId}/vitals`).set(...auth(cashier.token)).send(adultOk).expect(201);
    return encounterId;
  };

  const openSession = async (token: string, floatPaise = 200_000): Promise<string> => {
    const r = await http().post("/billing/sessions").set(...auth(token)).send({ floatPaise }).expect(201);
    return r.body.id as string;
  };

  /** Issues one line, paid in exact cash — the counter's own flow, over HTTP. */
  const issuePaid = async (patientId: string, serviceId: string, encounterId?: string): Promise<{
    invoiceId: string; netPayablePaise: number;
  }> => {
    const lines = [{ lineId: "l1", serviceId, qty: 1 }];
    const preview = await http().post("/billing/invoices/preview").set(...auth(cashier.token))
      .send({ encounterId, lines }).expect(201);
    const netPayablePaise = preview.body.totals.netPayablePaise as number;
    const issued = await http().post("/billing/invoices").set(...auth(cashier.token)).send({
      draftId: `d-${patientId}-${serviceId}`, patientId, encounterId, lines,
      receipt: { tenders: [{ mode: "cash", amountPaise: netPayablePaise }] },
    }).expect(201);
    return { invoiceId: issued.body.invoiceId as string, netPayablePaise };
  };

  const eventNames = async (): Promise<string[]> =>
    (await db.select({ name: events.name }).from(events)).map((r) => r.name);

  it("the counter flow: fee quote → invoice with receipt → settled, with the printed document", async () => {
    const patientId = await registerPatient("Asha Devi", "9876543210");
    const encounterId = await openVisit(patientId);
    await openSession(cashier.token);

    const quote = await http().get(`/billing/visits/${encounterId}/fee-quote`).set(...auth(cashier.token)).expect(200);
    expect(quote.body.free).toBe(false);
    expect(quote.body.visitType).toBe("new");
    expect(quote.body.feeServiceId).toBe(base.consultNewServiceId);
    // The consult service is priced 50000 paise and its GST category is EXEMPT, so netPayable is
    // the gross with no heads and no §170 rounding (50000 is a whole number of rupees).
    expect(quote.body.draft.totals.netPayablePaise).toBe(50_000);

    const issued = await http().post("/billing/invoices").set(...auth(cashier.token)).send({
      draftId: "draft-counter-1", patientId, encounterId,
      lines: [{ lineId: "fee", serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
    }).expect(201);
    expect(issued.body.invoiceNo).toMatch(/^INV\/\d{2}-\d{2}\/\d{6}$/);
    expect(issued.body.settlement).toEqual({ state: "settled", outstandingPaise: 0 });
    expect(issued.body.unallocatedPaise).toBe(0);
    expect(issued.body.receiptId).not.toBeNull();
    expect(issued.body.creditExtended).toBe(false);

    const invoiceId = issued.body.invoiceId as string;
    const detail = await http().get(`/billing/invoices/${invoiceId}`).set(...auth(cashier.token)).expect(200);
    expect(detail.body.lines).toHaveLength(1);
    expect(detail.body.settlement.state).toBe("settled");

    const printed = await http().get(`/billing/invoices/${invoiceId}/print`).set(...auth(cashier.token)).expect(200);
    expect(printed.body.letterhead).toEqual(DEFAULT_LETTERHEAD); // the ONE shipped letterhead (spec: one hospital)
    expect(printed.body.patient.uhid).toEqual(expect.any(String));
    expect(printed.body.qrPayload.startsWith(`bil1.invoice.${invoiceId}.`)).toBe(true);
    expect(printed.body.qrPayload.split(".")).toHaveLength(4); // bil1 . invoice . <id> . <sig>

    expect(await eventNames()).toEqual(expect.arrayContaining(["invoice.issued", "receipt.recorded", "payment.received"]));
  });

  it("the OPD gate over real HTTP: unpaid consult refused 409, paid at the counter, retry starts 201", async () => {
    const patientId = await registerPatient("Rina Kumari", "9876543211");
    const encounterId = await openVisit(patientId);

    // THE proof that billing.module.ts's OnModuleInit registration wired the guard into the
    // composed app: no test in this suite registers it, only AppModule's import does.
    //
    // 409, per D8: an unsettled fee is a STATE conflict, not a malformed request. T10 added
    // `consult_gate_refused` to `OpdErrorCode` but not to `OPD_CONFLICT_CODES`, so `opdStatus`
    // answered 400 until the follow-up repair commit put it in that set beside every other OPD
    // conflict code (`session_closed`, `slot_taken`, `not_your_patient`). The status AND the code
    // are both asserted: the code is what the screens branch on, the status is what D8 promises.
    const refused = await http().post(`/opd/visits/${encounterId}/consult/start`).set(...auth(dra.token)).expect(409);
    expect(refused.body.code).toBe("consult_gate_refused");
    expect(refused.body.detail.guard).toBe("billing_fee_gate");
    expect(refused.body.detail.code).toBe("fee_unsettled");

    await openSession(cashier.token);
    await issuePaid(patientId, base.consultNewServiceId, encounterId);

    const started = await http().post(`/opd/visits/${encounterId}/consult/start`).set(...auth(dra.token)).expect(201);
    expect(started.body.encounter.status).toBe("in_consultation");
  });

  it("dues: a credit-extended invoice is listed, then cleared by a receipt and an allocation", async () => {
    const patientId = await registerPatient("Meena Bai", "9876543212");
    await openSession(cashier.token);

    const issued = await http().post("/billing/invoices").set(...auth(cashier.token)).send({
      draftId: "draft-dues-1", patientId,
      lines: [{ lineId: "l1", serviceId: base.genericServiceId, qty: 1 }],
      credit: { reason: "the patient settles at the dues counter" },
    }).expect(201);
    expect(issued.body.creditExtended).toBe(true);
    expect(issued.body.settlement.state).toBe("unpaid");
    // Generic service: 50000 gross, taxable at 1200bps ⇒ heads taxHead(50000,1200) = 3000 each,
    // net 56000, already whole rupees ⇒ rounding 0.
    const outstanding = issued.body.settlement.outstandingPaise as number;
    expect(outstanding).toBe(56_000);

    const dues = await http().get(`/billing/patients/${patientId}/dues`).set(...auth(cashier.token)).expect(200);
    expect(dues.body.items).toHaveLength(1);
    expect(dues.body.items[0].invoiceId).toBe(issued.body.invoiceId);
    expect(dues.body.items[0].outstandingPaise).toBe(outstanding);

    const receipt = await http().post("/billing/receipts").set(...auth(cashier.token))
      .send({ patientId, tenders: [{ mode: "cash", amountPaise: outstanding }] }).expect(201);
    const allocated = await http().post(`/billing/receipts/${receipt.body.receiptId}/allocations`)
      .set(...auth(cashier.token))
      .send({ invoiceId: issued.body.invoiceId, amountPaise: outstanding }).expect(201);
    expect(allocated.body.settlement).toEqual({ state: "settled", outstandingPaise: 0 });

    const after = await http().get(`/billing/patients/${patientId}/dues`).set(...auth(cashier.token)).expect(200);
    expect(after.body.items).toEqual([]);
  });

  it("advances: a standalone receipt banks money, the balance reports it, and it clears a later invoice", async () => {
    const patientId = await registerPatient("Sita Rani", "9876543213");
    await openSession(cashier.token);

    const receipt = await http().post("/billing/receipts").set(...auth(cashier.token))
      .send({ patientId, tenders: [{ mode: "cash", amountPaise: 100_000 }], note: "advance" }).expect(201);
    expect(receipt.body.totalPaise).toBe(100_000);

    const balance = await http().get(`/billing/patients/${patientId}/balance`).set(...auth(cashier.token)).expect(200);
    expect(balance.body.advancePaise).toBe(100_000);
    expect(balance.body.outstandingPaise).toBe(0);

    const later = await http().post("/billing/invoices").set(...auth(cashier.token)).send({
      draftId: "draft-adv-1", patientId,
      lines: [{ lineId: "l1", serviceId: base.consultNewServiceId, qty: 1 }],
      credit: { reason: "settled from the patient's advance" },
    }).expect(201);
    await http().post(`/billing/receipts/${receipt.body.receiptId}/allocations`).set(...auth(cashier.token))
      .send({ invoiceId: later.body.invoiceId, amountPaise: 50_000 }).expect(201);

    const after = await http().get(`/billing/patients/${patientId}/balance`).set(...auth(cashier.token)).expect(200);
    expect(after.body.advancePaise).toBe(50_000);
    expect(after.body.outstandingPaise).toBe(0);
    expect(await eventNames()).toEqual(expect.arrayContaining(["advance.received", "payment.received"]));
  });

  it("credit note → refund voucher through the approvals routes → paid, and the worklist reads it back", async () => {
    const patientId = await registerPatient("Kavita Singh", "9876543214");
    await openSession(cashier.token);
    const { invoiceId, netPayablePaise } = await issuePaid(patientId, base.consultNewServiceId);

    const detail = await http().get(`/billing/invoices/${invoiceId}`).set(...auth(cashier.token)).expect(200);
    const invoiceLineId = detail.body.lines[0].id as string;

    const note = await http().post(`/billing/invoices/${invoiceId}/credit-notes`).set(...auth(cashier.token))
      .send({ kind: "refund", reason: "service not rendered", lines: [{ invoiceLineId, qty: 1 }] }).expect(201);
    expect(note.body.netPaise).toBe(netPayablePaise);
    const creditNoteId = note.body.creditNoteId as string;

    const requested = await http().post("/billing/refunds/request").set(...auth(cashier.token)).send({
      kind: "invoice_refund", creditNoteId, amountPaise: netPayablePaise,
      reasonClass: "mistake", reason: "wrong service billed",
    }).expect(201);
    const approvalId = requested.body.approvalId as string;

    await http().post(`/approvals/${approvalId}/approve`).set(...auth(manager.token))
      .send({ note: "refund approved at the counter" }).expect(201);

    const voucher = await http().post("/billing/refunds").set(...auth(cashier.token)).send({
      kind: "invoice_refund", creditNoteId, amountPaise: netPayablePaise,
      reasonClass: "mistake", reason: "wrong service billed", approvalId, method: "cash",
    }).expect(201);
    expect(voucher.body.status).toBe("issued");

    const paid = await http().post(`/billing/refunds/${voucher.body.voucherId}/pay`).set(...auth(cashier.token))
      .send({ payeeName: "Kavita Singh", payeeIdType: "aadhaar", payeeIdRef: "XXXX-1234" }).expect(201);
    expect(paid.body.status).toBe("paid");
    expect(await eventNames()).toEqual(expect.arrayContaining(["credit_note.issued", "refund_voucher.issued", "payment.refunded"]));

    const worklist = await http().get("/billing/refunds").query({ patientId }).set(...auth(cashier.token)).expect(200);
    expect(worklist.body.items).toHaveLength(1);
    expect(worklist.body.items[0].status).toBe("paid");
    expect(worklist.body.items[0].payeeName).toBe("Kavita Singh");
  });

  it("the session: variance close files the SoD approval, only the OWN cashier may confirm, and the list reads it back", async () => {
    const sessionId = await openSession(cashier.token, 200_000);

    // Counted 5 × ₹500 = 250000 paise against an expected 200000 float and no cash taken ⇒ +50000.
    const closing = await http().post(`/billing/sessions/${sessionId}/close`).set(...auth(cashier.token))
      .send({ denominations: { "50000": 5 }, note: "drawer over" }).expect(201);
    expect(closing.body.status).toBe("closing");
    expect(closing.body.countedCashPaise).toBe(250_000);
    expect(closing.body.expectedCashPaise).toBe(200_000);
    expect(closing.body.variancePaise).toBe(50_000);
    const approvalId = closing.body.varianceApprovalId as string;
    expect(approvalId).toEqual(expect.any(String));

    // CARRIED ITEM 3 — `confirmClose` performs no actor check of its own, so the ROUTE guards it.
    // `cashier2` holds the identical permission set, which is what makes this assertion
    // discriminate: a bare 403 would also be produced by the permission guard, so the refusal is
    // asserted by its CODE.
    const foreign = await http().post(`/billing/sessions/${sessionId}/confirm-close`).set(...auth(cashier2.token)).expect(403);
    expect(foreign.body.code).toBe("not_your_session");

    await http().post(`/approvals/${approvalId}/approve`).set(...auth(manager.token))
      .send({ note: "counted with the cashier, over by ₹500" }).expect(201);

    const closed = await http().post(`/billing/sessions/${sessionId}/confirm-close`).set(...auth(cashier.token)).expect(201);
    expect(closed.body.status).toBe("closed");

    // CARRIED ITEM 4 — `listSessions` shipped with no coverage at all; the route exercises it.
    const list = await http().get("/billing/sessions").query({ cashierUserId: cashier.id }).set(...auth(cashier.token)).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(sessionId);
    expect(list.body.items[0].status).toBe("closed");

    const current = await http().get("/billing/sessions/current").set(...auth(cashier.token)).expect(200);
    expect(current.body.session).toBeNull();
  });

  it("the 403 sweep: every route in the table refuses a permission-less user", async () => {
    expect(ROUTES).toHaveLength(31);
    for (const [method, path] of ROUTES) {
      const res = await http()[method](path).set(...auth(rando.token)).send({});
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
    }
  });

  it("refusal bodies: the OPD convention, a fractional paise 400, a readable message, and a bad config patch is 400 not 500", async () => {
    const patientId = await registerPatient("Nita Roy", "9876543215");
    await openSession(cashier.token);

    // Fractional paise: the M3 belt at the module boundary. `assertPaise` is the TARIFF module's
    // (pipeline-A carried item 8) so the throw is a TariffError — the wire contract must not
    // depend on which module's class raised it, and the body carries `invalid_paise` either way.
    const fractional = await http().post("/billing/invoices").set(...auth(cashier.token)).send({
      draftId: "draft-bad-1", patientId,
      lines: [{ lineId: "l1", serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 100.5 }] },
    }).expect(400);
    expect(fractional.body.statusCode).toBe(400);
    expect(fractional.body.code).toBe("invalid_paise");
    expect(typeof fractional.body.message).toBe("string");

    // CARRIED ITEM 2 — `BillingError` ships `message` OPTIONAL with `super(message ?? code)`, so a
    // code-only throw would render `message === code` on the wire. Every shipped throw site passes
    // a real message; this pins that the body is worth reading rather than an echoed code.
    const unsettled = await http().post("/billing/invoices").set(...auth(cashier.token)).send({
      draftId: "draft-bad-2", patientId,
      lines: [{ lineId: "l1", serviceId: base.consultNewServiceId, qty: 1 }],
    }).expect(409);
    expect(unsettled.body).toEqual({
      statusCode: 409,
      code: "unsettled_issue_refused",
      message: "50000p would be left unsettled and no credit extension was requested",
      detail: { remainderPaise: 50_000 },
    });
    expect(unsettled.body.message).not.toBe(unsettled.body.code);

    // CARRIED ITEM 1 — `updateBillingConfig` throws a RAW ZodError (T1's closed union has no
    // config-shape code and errors.ts is outside this task's Files list). Mapped at the
    // controller, so a bad patch is a 400 in the ratified shape and never a 500.
    const badPatch = await http().put("/billing/config").set(...auth(cashier.token))
      .send({ cashWarnPaise: "quite a lot" }).expect(400);
    expect(badPatch.body.statusCode).toBe(400);
    expect(badPatch.body.code).toBe("invalid_config");
    expect(Array.isArray(badPatch.body.detail)).toBe(true);
  });

  it("recon: a card statement outside tolerance mismatches the tender and lands on the worklist", async () => {
    const patientId = await registerPatient("Farida Khan", "9876543216");
    await openSession(cashier.token);
    const lines = [{ lineId: "l1", serviceId: base.consultNewServiceId, qty: 1 }];
    await http().post("/billing/invoices").set(...auth(cashier.token)).send({
      draftId: "draft-recon-1", patientId, lines,
      receipt: { tenders: [{ mode: "card", amountPaise: 50_000, refText: "TXN-1" }] },
    }).expect(201);

    // Card fee 150bps on 50000 ⇒ percentAmount(50000,150) = divHalfUp(7_500_000, 10_000) = 750,
    // so expectedNet = 49250 (stamped at CAPTURE). A settlement of 48000 is 1250 off, well past
    // the 100-paise tolerance ⇒ mismatched.
    const upload = await http().post("/billing/recon/upload").set(...auth(cashier.token)).send({
      source: "card",
      csv: "ref,settledPaise,settledOn\nTXN-1,48000,2026-08-20\nTXN-NOPE,10000,2026-08-20",
    }).expect(201);
    expect(upload.body.rowsTotal).toBe(2);
    expect(upload.body.rowsMismatched).toBe(1);
    expect(upload.body.unmatchedRefs).toEqual(["TXN-NOPE"]);

    const mismatches = await http().get("/billing/recon/mismatches").set(...auth(cashier.token)).expect(200);
    expect(mismatches.body.items).toHaveLength(1);
    expect(mismatches.body.items[0].expectedNetPaise).toBe(49_250);
    expect(mismatches.body.items[0].settledPaise).toBe(48_000);
  });

  it("reports: the day book and the GSTR-1 summary serve the T10 shapes over HTTP", async () => {
    const patientId = await registerPatient("Leela Nair", "9876543217");
    await openSession(cashier.token);
    await issuePaid(patientId, base.genericServiceId);
    const day = istDay(new Date());

    const book = await http().get("/billing/day-book").query({ day }).set(...auth(cashier.token)).expect(200);
    expect(book.body.day).toBe(day);
    expect(book.body.receipts.count).toBe(1);
    expect(book.body.receipts.byMode).toEqual({ cash: 56_000, upi: 0, card: 0 });
    expect(book.body.invoices).toEqual({ count: 1, netPayablePaise: 56_000 });
    expect(book.body.degraded).toEqual({ count: 0, totalPaise: 0 });

    // The generic service is the taxable "pharmacy" category: sac 3004 at 1200bps on a 50000
    // base ⇒ taxHead(50000, 1200) = divHalfUp(60_000_000, 20_000) = 3000 per head, SUMMED from
    // the stored line, never recomputed at the report layer (K35).
    const gstr1 = await http().get("/billing/gstr1").query({ from: day, to: day }).set(...auth(cashier.token)).expect(200);
    expect(gstr1.body.rows).toEqual([
      { buyerGstin: null, sacCode: "3004", rateBps: 1200, exempt: false, taxableBasePaise: 50_000, cgstPaise: 3_000, sgstPaise: 3_000 },
    ]);
  });

  it("config: the D-17 row is served, patched, and degraded mode flips it with its event", async () => {
    const before = await http().get("/billing/config").set(...auth(cashier.token)).expect(200);
    expect(before.body.cashBlockPaise).toBe(20_000_000);
    expect(before.body.degradedTender).toBe(false);
    expect(before.body.caSigned).toBe(false);

    const patched = await http().put("/billing/config").set(...auth(cashier.token))
      .send({ reconTolerancePaise: 250, caSigned: true }).expect(200);
    expect(patched.body.reconTolerancePaise).toBe(250);
    expect(patched.body.caSigned).toBe(true);

    const degraded = await http().put("/billing/degraded").set(...auth(cashier.token))
      .send({ on: true, reason: "PSP outage — refs typed by hand" }).expect(200);
    expect(degraded.body).toEqual({ degradedTender: true });
    expect(await eventNames()).toEqual(expect.arrayContaining(["degraded_mode.changed"]));

    const after = await http().get("/billing/config").set(...auth(cashier.token)).expect(200);
    expect(after.body.degradedTender).toBe(true);
    expect(after.body.reconTolerancePaise).toBe(250);
  });

  it("the registered gate passes through when billing is NOT configured — an unconfigured hospital still consults", async () => {
    const patientId = await registerPatient("Gita Das", "9876543218");
    const encounterId = await openVisit(patientId);
    // D-17 says a missing config row hard-fails every billing WRITE. A consult is not a billing
    // write, and `feeGate` converts EVERY BillingError — `billing_not_configured` included — into
    // a not-ok verdict, so registering it raw would make an unconfigured deployment refuse all
    // clinical work. `billing.module.ts` registers a wrapper that passes that ONE code through.
    await db.delete(billingConfig).where(eq(billingConfig.id, "main"));

    const started = await http().post(`/opd/visits/${encounterId}/consult/start`).set(...auth(dra.token)).expect(201);
    expect(started.body.encounter.status).toBe("in_consultation");
  });
});
