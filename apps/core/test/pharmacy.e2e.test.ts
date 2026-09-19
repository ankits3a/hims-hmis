import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { openSessionFor } from "./helpers/billing";
import { MON2, addAllergy, issueRx, line, seedPharmacyBase, stockIn } from "./helpers/pharmacy";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { events, operatingModeChanges, orderItems, pharmacyRegH1, stockBalances, stockLedger } from "../src/kernel/db/schema";
import { generateDowntimeKit, getKitPrintPayload } from "../src/kernel/ops/downtime-kit";
import { newId } from "@hmis/contracts";
import { grantPermissionToRole } from "../src/kernel/auth/permissions";
import { withTx } from "../src/kernel/db/client";
import { createStore } from "../src/modules/materials";
import { RETAIL_PHARMACY_STORE_CODE, istDateOf } from "../src/modules/pharmacy";
import { ensureRole, mkUser } from "./helpers/opd";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

jest.setTimeout(180_000);

/**
 * PLAN 16c T5 — ONE PATIENT, END TO END, OVER HTTP: the e-Rx from the doctor, the scan at the
 * counter, the pharmacist's verify, the FEFO pick from materials stock, the bill through billing at
 * batch grain, the hand-over that debits the ledger and writes the H1 register — every row read
 * back. The doctor's issue and the stock-in use the owning modules' own writers (the visit path and
 * `postMovement`); everything the pharmacy owns is exercised through its routes.
 */
describe("the OPD dispense counter over HTTP (16c T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
  let fx: PharmacyFixture;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    // P19 — a walk-in H1 sale files the prescription photo: the app gets a store it can write, as it
    // gets a database of its own. CI's default path (/var/lib/hmis/documents) is not writable.
    process.env.DOCUMENT_STORE_PATH = mkdtempSync(join(tmpdir(), "hmis-pharmacy-e2e-docs-"));
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 120_000);
  afterAll(async () => { await app.close(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
  });
  afterEach(() => { fx.unregister(); });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];
  const as = (token: string) => (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);

  it("refuses the anonymous and the unentitled", async () => {
    await request(server()).get("/pharmacy/queue").expect(401);
    await as(fx.clerk.token)(request(server()).get("/pharmacy/queue")).expect(403);
    await as(fx.aide.token)(request(server()).post("/pharmacy/sale-items").send({ itemId: fx.item.crocin })).expect(403);
    // P4 — the reorder list is read by anyone at the counter, and by nobody else.
    await as(fx.clerk.token)(request(server()).get("/pharmacy/reorder")).expect(403);
    const reorder = await as(fx.aide.token)(request(server()).get("/pharmacy/reorder")).expect(200);
    expect((reorder.body as { window: unknown }).window).toEqual({ days: 30, minCoverDays: 3, targetCoverDays: 7, nearExpiryDays: 90 });
    // P8 — both shelf-risk lists travel with it.
    expect(reorder.body).toMatchObject({ expiring: expect.any(Array), expiredOnShelf: expect.any(Array) });
    // P13 — the scan check is the picker's, and a missing code is refused before anything is read.
    await as(fx.clerk.token)(request(server()).get("/pharmacy/dispenses/nope/lines/0/scan?code=8901234567897")).expect(403);
    await as(fx.aide.token)(request(server()).get("/pharmacy/dispenses/nope/lines/0/scan")).expect(400);
    // PD-5b — the shelf a line nobody placed may be read as: the counter's search, not the downtime clerk's.
    await as(fx.clerk.token)(request(server()).get("/pharmacy/dispenses/nope/lines/0/shelf?q=cal")).expect(403);
    await as(fx.aide.token)(request(server()).get("/pharmacy/dispenses/nope/lines/x/shelf?q=cal")).expect(400);
    // P16 — the GST plan is the sale-item manager's, and applying it answers with what it did.
    await as(fx.aide.token)(request(server()).get("/pharmacy/sale-items/gst-plan")).expect(403);
    const gst = await as(fx.pharmacist.token)(request(server()).get("/pharmacy/sale-items/gst-plan")).expect(200);
    expect((gst.body as { items: { code: string }[] }).items.map((i) => i.code)).toEqual(["AZEE500", "CALP500", "CROC500"]);
    const appliedGst = await as(fx.pharmacist.token)(request(server()).post("/pharmacy/sale-items/gst-plan/apply").send({})).expect(201);
    expect(appliedGst.body).toEqual({ slabsSet: 0, categoriesSynced: 0 });
    // P12 — the leakage triangle is the billing supervisor's read, not the counter's.
    await as(fx.pharmacist.token)(request(server()).get("/pharmacy/leakage?day=2026-08-17")).expect(403);
    // P9 — the H1 register: the pharmacist's read, never the aide's; a period that is not dates is refused.
    await as(fx.aide.token)(request(server()).get("/pharmacy/registers/h1?from=2026-08-01&to=2026-08-31")).expect(403);
    const h1 = await as(fx.pharmacist.token)(request(server()).get("/pharmacy/registers/h1?from=2026-08-01&to=2026-08-31")).expect(200);
    expect(h1.body).toEqual({ period: { from: "2026-08-01", to: "2026-08-31" }, rows: [] });
    await as(fx.pharmacist.token)(request(server()).get("/pharmacy/registers/h1?from=2026-08-01")).expect(400);
    // P7 — the counter's day: read at the counter only, and a day that is not a date is refused.
    await as(fx.clerk.token)(request(server()).get("/pharmacy/summary")).expect(403);
    await as(fx.aide.token)(request(server()).get("/pharmacy/summary?day=2026-08-17")).expect(200);
    await as(fx.aide.token)(request(server()).get("/pharmacy/summary?day=yesterday")).expect(400);
    // P6 — a return is a money act too; and an unattested one never reaches the act.
    await as(fx.aide.token)(request(server()).post("/pharmacy/dispenses/d-any/returns").set("idempotency-key", "rt-1")
      .send({ lines: [{ lineIdx: 0, qtyBase: 10 }], sealedIntact: true, reason: "changed", reasonClass: "genuine" })).expect(403);
    await as(fx.pharmacist.token)(request(server()).post("/pharmacy/dispenses/d-any/returns").set("idempotency-key", "rt-2")
      .send({ lines: [{ lineIdx: 0, qtyBase: 10 }], sealedIntact: false, reason: "changed", reasonClass: "genuine" })).expect(400);
    // P5 — the refund route is a money act: the aide holds no billing string at all.
    await as(fx.aide.token)(request(server()).post("/pharmacy/dispenses/d-any/refund").set("idempotency-key", "r-1")
      .send({ reason: "expired before collection", reasonClass: "genuine" })).expect(403);
  });

  it("e-Rx → scan → claim → decline the unstocked line → verify (P number) → pick → bill → hand over → label; every row read back", async () => {
    const pharmacist = as(fx.pharmacist.token);
    const aide = as(fx.aide.token);
    const crocinBatch = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", expiryDate: "2027-03-31", qtyBase: 50, mrpPaise: 12000 });
    const azeeBatch = await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", expiryDate: "2027-06-30", qtyBase: 10, mrpPaise: 15000 });
    await addAllergy(db, fx.patient.id, "Sulfa");
    const { issued, tokenNo } = await issueRx(db, fx, [
      line({ drug: "Crocin 500", medicineId: fx.med.crocin }),
      line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 }),
      line({ drug: "Tab Mystery 10mg" }),
    ], { payFee: true });

    // the scan door
    const found = await pharmacist(request(server()).get("/pharmacy/find").query({ q: issued.qrPayload })).expect(200);
    expect(found.body).toMatchObject({ kind: "dispense", door: "rx_qr", dispense: { status: "queued", allergies: [{ substance: "Sulfa" }] } });
    const id = (found.body as { dispense: { id: string } }).dispense.id;
    // The token and UHID doors read TODAY's visits by the wall clock, and the fixture's visit is on a
    // fixed Monday; `counter.test.ts` proves both doors under a controlled clock. A scan is date-free.
    const strangerDoor = await pharmacist(request(server()).get("/pharmacy/find").query({ q: "T-99" })).expect(200);
    expect(strangerDoor.body).toEqual({ kind: "none", door: "token", reason: "not_found" });

    const claimed = await pharmacist(request(server()).post("/pharmacy/dispenses").set("idempotency-key", "claim-1").send({ dispenseId: id, door: "rx_qr" })).expect(201);
    expect(claimed.body).toMatchObject({ status: "claimed", scheduled: true });
    expect((claimed.body as { lines: { qtyBase: number | null; saleable: boolean }[] }).lines.map((l) => [l.qtyBase, l.saleable])).toEqual([[15, true], [3, true], [15, false]]);
    // a replay of the same idempotency key returns the same answer, not a second claim
    await pharmacist(request(server()).post("/pharmacy/dispenses").set("idempotency-key", "claim-1").send({ dispenseId: id, door: "rx_qr" })).expect(201);

    // PD-5b — the unplaced line can be searched for on this counter's shelf (the aide may look); nothing here is it, so it is declined.
    const shelf = await aide(request(server()).get(`/pharmacy/dispenses/${id}/lines/2/shelf`).query({ q: "croc" })).expect(200);
    expect((shelf.body as { items: { itemCode: string; available: number }[] }).items.map((e) => [e.itemCode, e.available])).toEqual([["CROC500", 50]]);
    await pharmacist(request(server()).post(`/pharmacy/dispenses/${id}/lines/2/decline`).send({ reason: "not stocked here" })).expect(201);
    const verified = await pharmacist(request(server()).post(`/pharmacy/dispenses/${id}/verify`).set("idempotency-key", "verify-1")
      .send({ lines: [{ lineIdx: 0, qtyBase: 20 }, { lineIdx: 1, qtyBase: 3 }] })).expect(201);
    expect(verified.body).toMatchObject({ status: "verified" });
    const dispenseNo = (verified.body as { dispenseNo: string }).dispenseNo;
    expect(dispenseNo).toMatch(/^P/);
    const queue = await pharmacist(request(server()).get("/pharmacy/queue")).expect(200); // today by the wall clock: the row was queued at the scan, now
    expect((queue.body as { items: { dispenseId: string; status: string; dispenseNo: string }[] }).items).toEqual([expect.objectContaining({ dispenseId: id, status: "verified", dispenseNo })]);

    const picked = await aide(request(server()).post(`/pharmacy/dispenses/${id}/pick`).set("idempotency-key", "pick-1").send({})).expect(201);
    expect((picked.body as { lines: { batchId: string | null; status: string }[] }).lines.map((l) => [l.status, l.batchId])).toEqual([["open", crocinBatch], ["open", azeeBatch], ["declined", null]]);

    const preview = await pharmacist(request(server()).get(`/pharmacy/dispenses/${id}/bill/preview`)).expect(200);
    const totals = (preview.body as { totals: { netPayablePaise: number }; lines: { unitPaise: number }[] });
    expect(totals.lines.map((l) => l.unitPaise)).toEqual([1200, 1500]); // MRP per tablet, no ceiling recorded for either
    await aide(request(server()).post(`/pharmacy/dispenses/${id}/bill`).send({ tenders: [{ mode: "cash", amountPaise: totals.totals.netPayablePaise }] })).expect(403);
    const billed = await pharmacist(request(server()).post(`/pharmacy/dispenses/${id}/bill`).set("idempotency-key", "bill-1")
      .send({ tenders: [{ mode: "cash", amountPaise: totals.totals.netPayablePaise }] })).expect(201);
    expect(billed.body).toMatchObject({ status: "billed" });
    expect((billed.body as { invoiceId: string | null }).invoiceId).not.toBeNull();

    // the aide cannot complete an H1 dispense; the pharmacist must confirm the person
    const refused = await aide(request(server()).post(`/pharmacy/dispenses/${id}/handover`).send({ identity: { via: "token", value: String(tokenNo) } })).expect(403);
    expect(refused.body).toMatchObject({ code: "scheduled_needs_pharmacist" });
    const noId = await pharmacist(request(server()).post(`/pharmacy/dispenses/${id}/handover`).send({})).expect(409);
    expect(noId.body).toMatchObject({ code: "identity_confirmation_required" });
    const handed = await pharmacist(request(server()).post(`/pharmacy/dispenses/${id}/handover`).set("idempotency-key", "hand-1")
      .send({ identity: { via: "token", value: String(tokenNo) } })).expect(201);
    expect(handed.body).toMatchObject({ status: "handed_over", identityConfirmedVia: "token" });

    const label = await pharmacist(request(server()).get(`/pharmacy/dispenses/${id}/label`)).expect(200);
    expect((label.body as { lines: { drug: string; qtyBase: number; batchNo: string; packs: string | null }[] }).lines.map((l) => [l.drug, l.qtyBase, l.batchNo, l.packs]))
      .toEqual([["Crocin 500", 20, "CR-1", "2 strip"], ["Azee 500", 3, "AZ-1", null]]);

    // ── read back: the ledger, the balance, the envelope, the register, the events ──
    const consumed = await db.select().from(stockLedger).where(eq(stockLedger.reason, "consume"));
    expect(consumed.map((c) => [c.batchId, c.qtyDelta]).sort()).toEqual([[azeeBatch, -3], [crocinBatch, -20]].sort());
    const [bal] = await db.select().from(stockBalances).where(eq(stockBalances.batchId, crocinBatch));
    expect(bal).toMatchObject({ qtyOnHand: 30, qtyReserved: 0 });
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, (handed.body as { orderId: string }).orderId));
    expect(items.map((i) => i.status).sort()).toEqual(["completed", "completed"]); // the declined line never reached the envelope
    expect(await db.select().from(pharmacyRegH1)).toHaveLength(1);
    const names = (await db.select({ name: events.name }).from(events)).map((e) => e.name);
    for (const n of ["dispense.queued", "dispense.claimed", "dispense.line_declined", "dispense.verified", "dispense.picked", "dispense.billed", "dispense.handed_over"]) {
      expect(names).toContain(n);
    }
    expect(names.filter((n) => n === "material.consumed")).toHaveLength(2);
    const consumedEv = await db.select().from(events).where(eq(events.name, "material.consumed"));
    expect(consumedEv.every((e) => (e.payload as { caseRef: { type: string } }).caseRef.type === "pharmacy_dispense")).toBe(true);
    void MON2;
  });

  /**
   * PHARMACY P2 — the register of pharmacists over HTTP: the permission gates the route, and the
   * act refuses a self-filed registration with its own code whatever the route allowed.
   */
  it("P2 — the register: listed, filed for a colleague, refused for oneself, and closed to the aide", async () => {
    const incharge = as(fx.incharge.token);
    const listed = await incharge(request(server()).get("/pharmacy/pharmacists")).expect(200);
    const rows = (listed.body as { items: { username: string; current: { registrationNo: string } | null }[] }).items;
    expect(rows.map((r) => [r.username, r.current?.registrationNo ?? null]).sort()).toEqual([["ph.incharge", null], ["ph.mehta", "MSPC-123456"]]);

    const self = await incharge(request(server()).post(`/pharmacy/pharmacists/${fx.incharge.id}/registrations`)
      .send({ council: "Maharashtra State Pharmacy Council", registrationNo: "MSPC-999" })).expect(403);
    expect((self.body as { code?: string }).code).toBe("self_registration");
    await as(fx.aide.token)(request(server()).get("/pharmacy/pharmacists")).expect(403);

    const filed = await as(fx.pharmacist.token)(request(server()).post(`/pharmacy/pharmacists/${fx.incharge.id}/registrations`)
      .send({ council: "Maharashtra State Pharmacy Council", registrationNo: "MSPC-999", validUntil: "2030-12-31" })).expect(201);
    const { id } = filed.body as { id: string };
    await as(fx.pharmacist.token)(request(server()).post(`/pharmacy/pharmacists/registrations/${id}/end`).send({ reason: "typed against the wrong person" })).expect(201);
  });

  /**
   * PHARMACY P19 — the walk-in counter over HTTP: shut until the licence is recorded, an OTC sale to
   * a customer registered at the counter (once, whatever the retries), and an H1 sale only on a
   * captured prescription, written to the register with the prescriber's address.
   */
  it("P19 — the walk-in counter: the licence, an OTC sale to a new customer, and an H1 sale on an outside prescription", async () => {
    const { resourceId: retailId } = await withTx(db, (tx) => createStore(tx, { type: "user", id: "01HMATERIALSHEAD00000000001" }, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" }));
    await ensureRole(db, "pharmacy_incharge");
    await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", "pharmacy.retail.manage");
    const licensee = await mkUser(db, "ph.licensee", ["pharmacy_incharge"]);
    const ph = as(fx.pharmacist.token);
    const today = istDateOf(new Date());

    await as(fx.aide.token)(request(server()).get("/pharmacy/retail/state")).expect(403);
    expect((await ph(request(server()).get("/pharmacy/retail/state")).expect(200)).body).toMatchObject({ state: "missing" });
    const licence = { form20No: "RLF20-1", form21No: "RLF21-1", validFrom: "2020-01-01", validTo: "2099-12-31", pharmacistInCharge: "A. Kulkarni" };
    await ph(request(server()).post("/pharmacy/retail/licences").send(licence)).expect(403);
    await as(licensee.token)(request(server()).post("/pharmacy/retail/licences").send({ ...licence, validTo: "2019-12-31" })).expect(400);
    await as(licensee.token)(request(server()).post("/pharmacy/retail/licences").send(licence)).expect(201);
    expect((await as(licensee.token)(request(server()).get("/pharmacy/retail/licences")).expect(200)).body).toMatchObject({ state: { state: "current" }, items: [{ form20No: "RLF20-1" }] });

    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "R-1", qtyBase: 50, expiryDate: "2099-12-31", resourceId: retailId });
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", qtyBase: 30, resourceId: retailId });
    const shelf = await ph(request(server()).get("/pharmacy/retail/shelf?q=croc")).expect(200);
    expect((shelf.body as { items: { itemCode: string; available: number }[] }).items).toEqual([expect.objectContaining({ itemCode: "CROC500", available: 50 })]);

    const otc = [{ medicineId: fx.med.crocin, qtyBase: 10 }];
    const preview = await ph(request(server()).post("/pharmacy/retail/preview").send({ lines: otc })).expect(201);
    const net = (preview.body as { totals: { netPayablePaise: number } }).totals.netPayablePaise;
    const customer = { register: { name: "Ramesh Patil", sex: "male", ageYears: 52, phone: "9822001122" } };
    await ph(request(server()).post("/pharmacy/retail/sales").send({ customer: { register: { ...customer.register, phone: "12345" } }, lines: otc, tenders: [{ mode: "cash", amountPaise: net }] })).expect(400);
    const sold = await ph(request(server()).post("/pharmacy/retail/sales").set("idempotency-key", "ws-1")
      .send({ customer, lines: otc, tenders: [{ mode: "cash", amountPaise: net }] })).expect(201);
    const sale = sold.body as { id: string; patient: { id: string; registeredHere: boolean }; netPaise: number; invoiceNo: string };
    expect(sale).toMatchObject({ patient: { registeredHere: true }, netPaise: net });
    const retried = await ph(request(server()).post("/pharmacy/retail/sales").set("idempotency-key", "ws-1")
      .send({ customer, lines: otc, tenders: [{ mode: "cash", amountPaise: net }] })).expect(201);
    expect((retried.body as { id: string }).id).toBe(sale.id);

    const h1 = [{ medicineId: fx.med.azithro, qtyBase: 3 }];
    const h1Net = ((await ph(request(server()).post("/pharmacy/retail/preview").send({ patientId: sale.patient.id, lines: h1 })).expect(201)).body as { totals: { netPayablePaise: number } }).totals.netPayablePaise;
    const noRx = await ph(request(server()).post("/pharmacy/retail/sales")
      .send({ customer: { existingId: sale.patient.id }, lines: h1, tenders: [{ mode: "upi", amountPaise: h1Net, refText: "UPI-1" }] })).expect(409);
    expect((noRx.body as { code: string }).code).toBe("prescription_required");
    const prescription = {
      prescriberName: "Dr R. Joshi", prescriberRegNo: "MMC-2011-04417", prescriberAddress: "Joshi Clinic, FC Road, Pune", rxDate: today,
      photo: { mimeType: "image/jpeg", imageBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64") },
    };
    const withRx = await ph(request(server()).post("/pharmacy/retail/sales")
      .send({ customer: { existingId: sale.patient.id }, lines: h1, prescription, tenders: [{ mode: "upi", amountPaise: h1Net, refText: "UPI-1" }] })).expect(201);
    expect(withRx.body).toMatchObject({ scheduled: true, pharmacistRegNo: "MSPC-123456", prescription: { prescriberAddress: "Joshi Clinic, FC Road, Pune" } });
    const [reg] = await db.select().from(pharmacyRegH1);
    expect(reg).toMatchObject({ dispenseLineId: null, prescriberAddress: "Joshi Clinic, FC Road, Pune", patientName: "Ramesh Patil" });

    const day = await ph(request(server()).get(`/pharmacy/retail/sales?day=${today}`)).expect(200);
    expect((day.body as { items: unknown[] }).items).toHaveLength(2);
    expect((await ph(request(server()).get(`/pharmacy/retail/sales/${sale.id}`)).expect(200)).body).toMatchObject({ id: sale.id, invoiceNo: sale.invoiceNo });
    await as(fx.clerk.token)(request(server()).get(`/pharmacy/retail/sales/${sale.id}`)).expect(403);

    // P19b — the bill comes back: found by its number, and a sealed strip returned once, whatever the retries.
    const bill = `/pharmacy/retail/bill?no=${encodeURIComponent(sale.invoiceNo)}`;
    expect((await ph(request(server()).get(bill)).expect(200)).body).toMatchObject({ id: sale.id, lines: [{ qtyBase: 10, returnedQtyBase: 0 }] });
    await as(fx.clerk.token)(request(server()).get(bill)).expect(403);
    await ph(request(server()).get("/pharmacy/retail/bill?no=INV-NOPE")).expect(404);
    const returns = `/pharmacy/retail/sales/${sale.id}/returns`;
    const giveBack = { lines: [{ lineIdx: 0, qtyBase: 10 }], sealedIntact: true, reason: "bought the wrong strength", reasonClass: "mistake" };
    await as(fx.aide.token)(request(server()).post(returns).send(giveBack)).expect(403);
    await ph(request(server()).post(returns).send({ ...giveBack, sealedIntact: false })).expect(400);
    const back = await ph(request(server()).post(returns).set("idempotency-key", "wr-1").send(giveBack)).expect(201);
    expect(back.body).toMatchObject({ sale: { id: sale.id, lines: [{ returnedQtyBase: 10 }] }, creditNoteNo: expect.any(String) });
    const again = await ph(request(server()).post(returns).set("idempotency-key", "wr-1").send(giveBack)).expect(201);
    expect((again.body as { creditNoteId: string }).creditNoteId).toBe((back.body as { creditNoteId: string }).creditNoteId);
    const more = await ph(request(server()).post(returns).send(giveBack)).expect(409);
    expect((more.body as { code: string }).code).toBe("return_exceeds_dispensed");

    // P19b — the walk-in store's leakage triangle, read by whoever reads the counter's.
    await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", "billing.reports.read");
    const leak = await as(licensee.token)(request(server()).get(`/pharmacy/leakage?day=${today}&store=PHARM-RETAIL`)).expect(200);
    expect(leak.body).toMatchObject({ store: { code: "PHARM-RETAIL" }, dispensed: { lines: 2 }, mismatches: [], otherConsumption: [] });
    await as(licensee.token)(request(server()).get(`/pharmacy/leakage?day=${today}&store=MAIN`)).expect(400);
  });

  /**
   * PHARMACY P20 — a paper dispense over HTTP, signed with the key the API itself uses: the sheet is
   * checked, the entry is recorded at the time on the sheet, and the sheet is then spent.
   */
  it("P20 — a downtime sheet: checked, entered at the time written on it, and refused the second time", async () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });
    const now = Date.now();
    const duty = { type: "user" as const, id: "01HDUTYMANAGER000000000010" };
    const mode = (from: string, to: string, at: number) => ({ id: newId(), fromMode: from, toMode: to, note: to === "downtime" ? "UPS failure" : null, reportId: null, actorId: duty.id, at: new Date(at) });
    await db.insert(operatingModeChanges).values([
      mode("commissioning", "normal", now - 3 * 3_600_000), mode("normal", "downtime", now - 2 * 3_600_000), mode("downtime", "normal", now - 3_600_000),
    ]);
    const kit = await withTx(db, (tx) => generateDowntimeKit(tx, duty, { note: null, desks: [{ desk: "pharmacy-counter", counts: { receipt: 2 } }] }, new Date(now - 150 * 60_000)));
    const [sheetQr] = (await getKitPrintPayload(db, cfg.secretKey, kit.id)).ranges[0]!.forms.map((f) => f.qr);
    const batchId = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-P", qtyBase: 40 });
    const ph = as(fx.pharmacist.token);

    await as(fx.aide.token)(request(server()).get(`/pharmacy/downtime/sheet?qr=${encodeURIComponent(sheetQr!)}`)).expect(403);
    expect((await ph(request(server()).get(`/pharmacy/downtime/sheet?qr=${encodeURIComponent(sheetQr!)}`)).expect(200)).body)
      .toMatchObject({ valid: true, desk: "pharmacy-counter", serial: 1, enteredSaleId: null });
    const occurredAt = new Date(now - 90 * 60_000).toISOString();
    const body = {
      sheetQr, storeCode: "PHARM-OPD", occurredAt, dispensedBy: fx.pharmacist.id, customer: { existingId: fx.patient.id },
      lines: [{ medicineId: fx.med.crocin, qtyBase: 10, batchId }], tenders: [{ mode: "cash", amountPaise: 12000 }],
    };
    await ph(request(server()).post("/pharmacy/downtime/dispenses").send({ ...body, lines: [{ medicineId: fx.med.crocin, qtyBase: 10 }] })).expect(400);
    await ph(request(server()).post("/pharmacy/downtime/dispenses").send({ ...body, storeCode: "MAIN" })).expect(400);
    const entered = await ph(request(server()).post("/pharmacy/downtime/dispenses").set("idempotency-key", "pd-1").send(body)).expect(201);
    expect(entered.body).toMatchObject({ channel: "downtime", soldAt: occurredAt, sheet: { serial: 1, desk: "pharmacy-counter" }, netPaise: 12000 });
    const again = await ph(request(server()).post("/pharmacy/downtime/dispenses").send(body)).expect(409);
    expect((again.body as { code: string }).code).toBe("sheet_already_entered");
    const outside = await ph(request(server()).post("/pharmacy/downtime/dispenses")
      .send({ ...body, sheetQr: (await getKitPrintPayload(db, cfg.secretKey, kit.id)).ranges[0]!.forms[1]!.qr, occurredAt: new Date(now - 30 * 60_000).toISOString() })).expect(409);
    expect((outside.body as { code: string }).code).toBe("not_in_downtime");
    const listed = await ph(request(server()).get("/pharmacy/downtime/dispenses")).expect(200);
    expect((listed.body as { items: { id: string }[] }).items.map((r) => r.id)).toEqual([(entered.body as { id: string }).id]);
  });
});
