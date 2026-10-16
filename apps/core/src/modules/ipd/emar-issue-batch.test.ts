import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { idempotencyKeys, stockBalances, stockBatches } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkEmarWorld } from "../../../test/helpers/ipd";
import { postMovement } from "../materials";
import { IpdEmarController } from "./emar.controller";
import { IpdRefusal, issueMed, placeIpOrder, verifyOrder } from "./index";
import type { Db } from "../../kernel/db/client";
import type { EmarWorld } from "../../../test/helpers/ipd";
import type { Actor } from "@hmis/contracts";

/**
 * E4.3 eMAR — the ward issue: a named batch must be one FEFO could sell today (never expired), and the route answers the
 * idempotency helper's refusals (a key in flight, or reused with another body) with 409, never a 500.
 */
jest.setTimeout(300_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const TICKS = { allergy: true, interaction: true, dose: true, duplicate: true };
const T0 = ist("2026-03-11T07:00:00");

describe("E4.3 eMAR — the ward issue's named batch and its route", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: EmarWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkEmarWorld(db); });

  async function verified(): Promise<{ orderId: string; itemId: string }> {
    const adm = await w.admitMed(ist("2026-03-10T10:00:00"));
    const med = await w.stocked(`Wardol ${String(Math.random()).slice(2, 7)}`, { qty: 20 });
    const placed = await placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId: adm.admissionId, kind: "drug",
      drug: { itemId: med.medicineId, dose: { value: 500, unit: "mg" }, route: "oral", frequency: "TDS", startAt: T0.toISOString(), antibiotic: false, durationDays: 5 },
    }, { now: T0 });
    await verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, decision: "verified", checks: TICKS, note: "checked" }, { now: ist("2026-03-11T07:30:00") });
    return { orderId: placed.orderId, itemId: med.itemId };
  }

  it("a named batch that has expired is never issued to the ward; nothing moves", async () => {
    const r = await verified();
    const expired = newId();
    await db.insert(stockBatches).values({
      id: expired, itemId: r.itemId, batchNo: `EX-${expired.slice(-6)}`, expiryDate: "2026-03-01", mrpPaise: 1000, mrpUom: "strip",
      landedCostPaise: 500, ownership: "owned", createdBy: HEAD.id,
    } as never);
    await withTx(db, (tx) => postMovement(tx, HEAD, { resourceId: w.storeId, batchId: expired, qtyDelta: 10, reason: "grn", refType: "test", refId: expired, occurredAt: new Date("2026-01-01T00:00:00Z") }));
    const code = await issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: r.orderId, units: 2, ownMedicine: false, batchId: expired }, { now: ist("2026-03-11T07:40:00") })
      .then(() => "issued", (e: unknown) => (e instanceof IpdRefusal ? e.code : String(e)));
    expect(code).toBe("batch_mismatch");
    const onHand = (await db.select().from(stockBalances).where(and(eq(stockBalances.resourceId, w.storeId), eq(stockBalances.batchId, expired))))[0]?.qtyOnHand;
    expect(onHand).toBe(10);
  });

  it("a key the server already holds (in flight, or another body) answers 409 at the route, never a 500", async () => {
    const r = await verified();
    const k = key();
    await db.insert(idempotencyKeys).values({
      id: newId(), actorId: w.pharmacist.id, route: "ipd:issue_med", key: k.toLowerCase(), requestHash: "a-different-attempt", state: "in_progress", claimedAt: T0,
    } as never);
    const err = await new IpdEmarController(db).issue(w.pharmacist, { idempotencyKey: k, orderId: r.orderId, units: 2, ownMedicine: false }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(409);
  });
});
