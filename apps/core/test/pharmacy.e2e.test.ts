import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { openSessionFor } from "./helpers/billing";
import { MON2, addAllergy, issueRx, line, seedPharmacyBase, stockIn } from "./helpers/pharmacy";
import { requireEnv } from "../src/kernel/config";
import { events, orderItems, pharmacyRegH1, stockBalances, stockLedger } from "../src/kernel/db/schema";
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
});
