import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkDoctor, mkUser, seedOpdBase, seedOpdMasters, activateOpdVisitDefinition } from "./helpers/opd";
import { mkBillingManager, mkCashier, seedBillingBase } from "./helpers/billing";
import { billingConfig, events, receipts, refundVouchers } from "../src/kernel/db/schema";
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
 * EACH ENTRY ALSO CARRIES THE PERMISSION ITS DECORATOR NAMES (§3.42 / §2.37). The sweep asserts
 * the kernel guard's `missing permission <x>` per route, so all 31 BINDINGS are asserted rather
 * than the 4 the shaped two-actor test below reaches: a route repointed at a different existing
 * permission now fails BY NAME instead of answering the same anonymous 403.
 *
 * The load-bearing leg is test 2. T10's own gate test registers the guard BY HAND, so this suite
 * is the only place the module-init registration in `billing.module.ts` is exercised: an unpaid
 * `new` visit is refused at `/opd/.../consult/start` with 409 `consult_gate_refused`, the fee is
 * taken through the billing routes, and the retry starts 201 — all through the composed app.
 */
const ROUTES: [method: "get" | "post" | "put", path: string, permission: string][] = [
  ["post", "/billing/invoices", "billing.invoice.issue"],
  ["post", "/billing/invoices/preview", "billing.invoice.issue"],
  ["get", "/billing/invoices", "billing.invoice.read"],
  ["get", "/billing/invoices/X", "billing.invoice.read"],
  ["get", "/billing/invoices/X/print", "billing.invoice.read"],
  ["post", "/billing/invoices/X/credit-notes", "billing.credit_note.issue"],
  ["get", "/billing/invoices/X/credit-notes", "billing.invoice.read"],
  ["get", "/billing/visits/X/fee-quote", "billing.invoice.read"],
  ["post", "/billing/receipts", "billing.receipt.record"],
  ["get", "/billing/receipts", "billing.invoice.read"],
  ["post", "/billing/receipts/X/allocations", "billing.receipt.record"],
  ["post", "/billing/allocations/X/reverse", "billing.allocation.reverse"],
  ["post", "/billing/eie", "billing.eie.mark"],
  ["get", "/billing/patients/X/balance", "billing.invoice.read"],
  ["get", "/billing/patients/X/dues", "billing.invoice.read"],
  ["post", "/billing/refunds/request", "billing.refund.request"],
  ["post", "/billing/refunds", "billing.refund.request"],
  ["post", "/billing/refunds/X/pay", "billing.refund.pay"],
  ["get", "/billing/refunds", "billing.reports.read"],
  ["post", "/billing/sessions", "billing.session.own"],
  ["get", "/billing/sessions/current", "billing.session.own"],
  ["post", "/billing/sessions/X/close", "billing.session.own"],
  ["post", "/billing/sessions/X/confirm-close", "billing.session.own"],
  ["get", "/billing/sessions", "billing.session.read"],
  ["post", "/billing/recon/upload", "billing.recon.upload"],
  ["get", "/billing/recon/mismatches", "billing.reports.read"],
  ["get", "/billing/day-book", "billing.reports.read"],
  ["get", "/billing/gstr1", "billing.reports.read"],
  ["get", "/billing/config", "billing.reports.read"],
  ["put", "/billing/config", "billing.config.write"],
  ["put", "/billing/degraded", "billing.config.write"],
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

  /**
   * THE RULE 114B DISCLOSURE. `GET /billing/receipts` is guarded by `billing.invoice.read`, which
   * the README grants to EVERY CASHIER, and it answered `select().from(receipts)` — the raw row,
   * `panNumber` and all — so one unfiltered GET enumerated every patient's PAN. The projection
   * drops the number and derives `panCaptured` in its place, so the counter still sees WHETHER the
   * 114B capture happened.
   *
   * THE FIXTURE CARRIES THE VALUE, and the table is read first to prove it (evidence discipline 6):
   * an absence assertion over a fixture that never stored a PAN would prove nothing.
   */
  it("receipts list: the stored 114B PAN never reaches the wire, panCaptured does, and the screens' fields survive", async () => {
    const withPan = await registerPatient("Suman Lata", "9876543220");
    const withoutPan = await registerPatient("Rekha Devi", "9876543221");
    await openSession(cashier.token);

    // ₹60,000 cash — ABOVE the D-17 PAN threshold (5_000_000p) and below both the warn
    // (15_000_000p) and block (20_000_000p) thresholds, so this is the real §139A capture path and
    // not a PAN handed over for no reason.
    const panReceipt = await http().post("/billing/receipts").set(...auth(cashier.token)).send({
      patientId: withPan, tenders: [{ mode: "cash", amountPaise: 6_000_000 }], panNumber: "ABCDE1234F",
    }).expect(201);
    const plainReceipt = await http().post("/billing/receipts").set(...auth(cashier.token)).send({
      patientId: withoutPan, tenders: [{ mode: "cash", amountPaise: 50_000 }], note: "advance",
    }).expect(201);

    // `receipts.pan_number` is the column that would put the PAN on the wire: populated for one
    // fixture row, null for the other.
    const stored = await db.select({ id: receipts.id, panNumber: receipts.panNumber }).from(receipts);
    expect(stored.find((r) => r.id === panReceipt.body.receiptId)?.panNumber).toBe("ABCDE1234F");
    expect(stored.find((r) => r.id === plainReceipt.body.receiptId)?.panNumber).toBeNull();

    const list = await http().get("/billing/receipts").set(...auth(cashier.token)).expect(200);
    expect(list.body.items).toHaveLength(2);

    // ABSENT FROM THE PARSED BODY — the KEY is gone, not merely a rendered string that omits it.
    for (const item of list.body.items as Record<string, unknown>[]) {
      expect(Object.keys(item)).not.toContain("panNumber");
      expect("panNumber" in item).toBe(false);
    }
    expect(JSON.stringify(list.body)).not.toContain("ABCDE1234F"); // belt: nowhere in the payload

    // Arrival order is `seq` DESC, never the id (§3.26) — newest first, unchanged by the rewrite.
    const [newest, oldest] = list.body.items as [Record<string, unknown>, Record<string, unknown>];
    expect(newest.id).toBe(plainReceipt.body.receiptId);
    expect(oldest.id).toBe(panReceipt.body.receiptId);
    expect(Number(newest.seq)).toBeGreaterThan(Number(oldest.seq));

    // THE 114B SIGNAL SURVIVES THE REDACTION, in BOTH directions.
    expect(oldest.panCaptured).toBe(true);
    expect(newest.panCaptured).toBe(false);

    // NOT OVER-BROAD (§3.44): a projection that redacts more than the one sensitive datum breaks
    // the four screens about to be built on this route, and no mutant would catch it.
    expect(oldest.receiptNo).toMatch(/^RCP\/\d{2}-\d{2}\/\d{6}$/);
    expect(oldest.totalPaise).toBe(6_000_000);
    expect(oldest.patientId).toBe(withPan);
    expect(oldest.receivedBy).toBe(cashier.id);
    expect(typeof oldest.receivedAt).toBe("string");
    expect(oldest.serviceDay).toBe(istDay(new Date()));
    expect(oldest.degraded).toBe(false);
    expect(oldest.form60).toBe(false);
    expect(typeof oldest.cashierSessionId).toBe("string");
    expect(newest.note).toBe("advance");

    // The `patientId` filter survives the rewrite from `select()` to an explicit projection.
    const filtered = await http().get("/billing/receipts").query({ patientId: withPan })
      .set(...auth(cashier.token)).expect(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].id).toBe(panReceipt.body.receiptId);
    expect(filtered.body.items[0].panCaptured).toBe(true);
    expect("panNumber" in filtered.body.items[0]).toBe(false);
  });

  /**
   * The refund worklist's own disclosure: `payeeIdRef` is the identity-DOCUMENT reference captured
   * when the money leaves. `payeeName` and `payeeIdType` STAY — a worklist must show who is being
   * paid and against what kind of document; the reference is verified against the physical document
   * at pay time, never read off a list.
   */
  it("refunds worklist: the payee identity REFERENCE never reaches the wire, the name and id TYPE do", async () => {
    const patientId = await registerPatient("Anita Verma", "9876543222");
    await openSession(cashier.token);
    const { invoiceId, netPayablePaise } = await issuePaid(patientId, base.consultNewServiceId);

    const detail = await http().get(`/billing/invoices/${invoiceId}`).set(...auth(cashier.token)).expect(200);
    const note = await http().post(`/billing/invoices/${invoiceId}/credit-notes`).set(...auth(cashier.token))
      .send({ kind: "refund", reason: "service not rendered", lines: [{ invoiceLineId: detail.body.lines[0].id, qty: 1 }] })
      .expect(201);
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
    await http().post(`/billing/refunds/${voucher.body.voucherId}/pay`).set(...auth(cashier.token))
      .send({ payeeName: "Anita Verma", payeeIdType: "aadhaar", payeeIdRef: "9911-2233-4455" }).expect(201);

    // `refund_vouchers.payee_id_ref` is the column that would put the identity document on the
    // wire, and the fixture carries it (evidence discipline 6).
    const [storedVoucher] = await db
      .select({ payeeIdRef: refundVouchers.payeeIdRef })
      .from(refundVouchers).where(eq(refundVouchers.id, voucher.body.voucherId as string));
    expect(storedVoucher?.payeeIdRef).toBe("9911-2233-4455");

    const worklist = await http().get("/billing/refunds").set(...auth(cashier.token)).expect(200);
    expect(worklist.body.items).toHaveLength(1);
    const [row] = worklist.body.items as [Record<string, unknown>];
    expect(Object.keys(row)).not.toContain("payeeIdRef");
    expect("payeeIdRef" in row).toBe(false);
    expect(JSON.stringify(worklist.body)).not.toContain("9911-2233-4455");

    // NOT OVER-BROAD (§3.44): a worklist that cannot say who is paid, for how much, against what
    // kind of document, is not a worklist.
    expect(row.voucherNo).toMatch(/^RFV\/\d{2}-\d{2}\/\d{6}$/);
    expect(row.amountPaise).toBe(netPayablePaise);
    expect(row.status).toBe("paid");
    expect(row.payeeName).toBe("Anita Verma");
    expect(row.payeeIdType).toBe("aadhaar");
    expect(row.patientId).toBe(patientId);
    expect(row.id).toBe(voucher.body.voucherId);
    expect(row.kind).toBe("invoice_refund");
    expect(row.method).toBe("cash");
    expect(row.reasonClass).toBe("mistake");
    expect(row.approvalId).toBe(approvalId);
    expect(Array.isArray(row.guardFlags)).toBe(true);
    expect(row.paidBy).toBe(cashier.id);
    expect(typeof row.issuedAt).toBe("string");
    expect(typeof row.paidAt).toBe("string");
    expect(Object.keys(row)).toContain("cashierSessionId");
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

  it("the 403 sweep: every route in the table refuses a permission-less user, BY THE PERMISSION IT NAMES", async () => {
    expect(ROUTES).toHaveLength(31);
    for (const [method, path, permission] of ROUTES) {
      const res = await http()[method](path).set(...auth(rando.token)).send({});
      expect({ method, path, status: res.status, message: res.body.message }).toEqual({
        method, path, status: 403, message: `missing permission ${permission}`,
      });
    }
  });

  /**
   * §2.37 — THE TWO LEGS THE TRANSCRIPTION CANNOT SUPPLY. The permission column above is copied
   * from the decorators, so the sweep on its own is a REGRESSION PIN: it catches a decorator that
   * MOVES without the table, never one that was wrong the day both were written. Neither assertion
   * below reads the table's permission column against the decorators — they read it against the
   * MANIFEST and against a real grant set, which are two independent sources.
   */
  it("the guarded set closes over the manifest: every demanded permission is declared, and exactly one declared permission guards no route", () => {
    const guarded = [...new Set(ROUTES.map(([, , permission]) => permission))].sort();
    const declared = [...billingManifest.permissions].sort();
    // A route demanding a permission the manifest never declares is a route `syncPermissions`
    // leaves unreachable by EVERY role, forever — and the role-less sweep above answers 403 for it
    // exactly as it does for a correctly guarded route, so nothing else in this file can tell them
    // apart.
    expect(guarded.filter((permission) => !declared.includes(permission))).toEqual([]);
    // The other direction, and the reason it is `toEqual` and not `toContain`:
    // `billing.credit.extend` is the ONE declared permission no route guards — it is checked INSIDE
    // `issueInvoice` (D2 step 3, owner ruling 2) on the same `POST /billing/invoices` a plain issue
    // uses. A SECOND name appearing here is a route that was dropped from the controller or a
    // decorator repointed away from its permission.
    expect(declared.filter((permission) => !guarded.includes(permission))).toEqual(["billing.credit.extend"]);
  });

  it("the granted direction: the all-fourteen cashier is refused for a MISSING PERMISSION on no route in the table", async () => {
    for (const [method, path] of ROUTES) {
      const res = await http()[method](path).set(...auth(cashier.token)).send({});
      // Deliberately NOT a status assertion: an empty body legitimately answers 400/404/409 here,
      // and `POST /billing/sessions/:id/confirm-close` answers 403 for OWNERSHIP. The permission
      // guard is the only refusal that names a permission, so that is what is asserted absent —
      // which is what makes a decorator pointing at an undeclared or misspelt permission fail here
      // even though the sweep above and the manifest leg would both still pass.
      const message: unknown = res.body?.message;
      const refusedForPermission = typeof message === "string" && message.startsWith("missing permission ");
      expect({ method, path, refusedForPermission, message }).toEqual({ method, path, refusedForPermission: false, message });
    }
  });

  /**
   * §3.42 — THE ROUTE→PERMISSION MAP, WITH A SECOND ACTOR. The sweep above asserts all 31 bindings
   * by name, but it drives them with a user holding NO ROLES AT ALL: it proves what each route
   * DEMANDS, never that a REAL, NON-EMPTY grant set is ADMITTED on its own routes and REFUSED on
   * the other role's. Every positive path in this file uses ONE cashier holding all fourteen
   * billing permissions at once, which can never observe a wrong grant either. This test is the
   * assertion that would have caught the raw `receipts` row (PAN included) sitting behind
   * every-cashier `billing.invoice.read`.
   *
   * So: a SECOND actor holding a REAL, NON-EMPTY set. Both sets are the README's own "Recommended
   * permission grants" split — its cashier column and its billing_manager column — carried on
   * dedicated roles so no shipped fixture is disturbed. THE ROUTES BELOW COME FROM THE DECORATORS,
   * not from the README: `POST /billing/receipts` is `billing.receipt.record` and `POST
   * /billing/invoices` is `billing.invoice.issue` (counter column only); `GET /billing/refunds` is
   * `billing.reports.read` and `GET /billing/sessions` is `billing.session.read` (office column
   * only). Each refusal is checked by the PERMISSION IT NAMES — the kernel guard's `missing
   * permission <x>` — so a route repointed at a different permission cannot answer the same 403.
   */
  it("the permission MAP: the counter set and the office set are each refused on the other's routes, by name", async () => {
    const COUNTER_SET = [
      "billing.invoice.issue", "billing.invoice.read", "billing.credit.extend",
      "billing.receipt.record", "billing.credit_note.issue",
      "billing.refund.request", "billing.refund.pay", "billing.session.own",
    ];
    const OFFICE_SET = [
      "billing.invoice.read", "billing.allocation.reverse", "billing.session.read",
      "billing.recon.upload", "billing.reports.read", "billing.config.write", "billing.eie.mark",
    ];
    const counter = await mkUser(db, "shaped_counter", ["shaped_counter_role"]);
    const office = await mkUser(db, "shaped_office", ["shaped_office_role"]);
    for (const p of COUNTER_SET) await grantPermissionToRole(db, registry, "shaped_counter_role", p);
    for (const p of OFFICE_SET) await grantPermissionToRole(db, registry, "shaped_office_role", p);

    const patientId = await registerPatient("Bela Ghosh", "9876543223");

    // BOTH SETS ARE REAL AND NON-EMPTY — without this leg a role-less user would satisfy every
    // refusal below, which is precisely what the sweep already does and why it proves nothing.
    await openSession(counter.token);
    await http().post("/billing/receipts").set(...auth(counter.token))
      .send({ patientId, tenders: [{ mode: "cash", amountPaise: 50_000 }] }).expect(201);
    const officeWorklist = await http().get("/billing/refunds").set(...auth(office.token)).expect(200);
    expect(officeWorklist.body.items).toEqual([]);

    // DIRECTION 1 — routes the counter set reaches and the office set must NOT.
    const officeOnReceipts = await http().post("/billing/receipts").set(...auth(office.token))
      .send({ patientId, tenders: [{ mode: "cash", amountPaise: 50_000 }] }).expect(403);
    expect(officeOnReceipts.body.message).toBe("missing permission billing.receipt.record");
    const officeOnIssue = await http().post("/billing/invoices").set(...auth(office.token)).send({}).expect(403);
    expect(officeOnIssue.body.message).toBe("missing permission billing.invoice.issue");

    // DIRECTION 2 — routes the office set reaches and the counter set must NOT.
    const counterOnRefunds = await http().get("/billing/refunds").set(...auth(counter.token)).expect(403);
    expect(counterOnRefunds.body.message).toBe("missing permission billing.reports.read");
    const counterOnSessions = await http().get("/billing/sessions").set(...auth(counter.token)).expect(403);
    expect(counterOnSessions.body.message).toBe("missing permission billing.session.read");
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
