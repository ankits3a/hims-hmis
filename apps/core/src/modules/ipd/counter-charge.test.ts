import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { idempotencyKeys, ipdAdmissions, ipdChargeLines, patients, stockBalances, stockBatches } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkEmarWorld } from "../../../test/helpers/ipd";
import { postMovement } from "../materials";
import { upsertGstCategory } from "../tariff";
import { syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ipdManifest } from "./manifest";
import { IpdCounterController } from "./counter.controller";
import { IpdError, IpdRefusal, counterCharge, counterReturn, lookupCounterAdmission, readCounterSales, registerIpdOrderChargeSink } from "./index";
import type { Db } from "../../kernel/db/client";
import type { EmarWorld } from "../../../test/helpers/ipd";
import type { Actor } from "@hmis/contracts";

/**
 * #787 (IP counter) review — the counter charge's defects found in review of 73731986, each pinned here (not in the
 * acceptance file): a sale charges exactly the units asked, the same medicine twice in one sale, a named batch that may not
 * be sold, the sealed-identity rule at the lookup, and the idempotency answer at the route.
 */
jest.setTimeout(300_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const SALE_AT = ist("2026-03-11T11:00:00");

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    if (e instanceof IpdRefusal || e instanceof IpdError) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("#787 (IP counter) review — counter charge defects", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: EmarWorld;
  const off: (() => void)[] = [];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkEmarWorld(db);
    await withTx(db, (tx) => upsertGstCategory(tx, w.tariffDrafter, { category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, specialRule: null, thresholdPaise: null }));
    const registry = new ModuleRegistry();
    registry.install(ipdManifest);
    await syncPermissions(db, registry);
    off.push(registerIpdOrderChargeSink());
  });
  afterEach(() => { while (off.length > 0) off.pop()!(); });

  const pharmacyLines = async (admissionId: string) => (await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, admissionId)))
    .filter((l) => l.source === "ipd.pharmacy");
  const onHand = async (batchId: string) => (await db.select().from(stockBalances).where(and(eq(stockBalances.resourceId, w.storeId), eq(stockBalances.batchId, batchId))))[0]?.qtyOnHand ?? 0;
  const addBatch = async (itemId: string, opts: { qty: number; expiry: string }) => {
    const batchId = newId();
    await db.insert(stockBatches).values({
      id: batchId, itemId, batchNo: `RV-${batchId.slice(-6)}`, expiryDate: opts.expiry, mrpPaise: 1000, mrpUom: "strip",
      landedCostPaise: 500, ownership: "owned", createdBy: HEAD.id,
    } as never);
    await withTx(db, (tx) => postMovement(tx, HEAD, { resourceId: w.storeId, batchId, qtyDelta: opts.qty, reason: "grn", refType: "test", refId: batchId, occurredAt: new Date("2026-01-01T00:00:00Z") }));
    return batchId;
  };
  const admitted = async () => {
    const r = await w.admitMed(ist("2026-03-10T10:00:00"));
    const a = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, r.admissionId)))[0]!;
    const uhid = (await db.select({ uhid: patients.uhid }).from(patients).where(eq(patients.id, r.patientId)))[0]!.uhid;
    return { ...r, admissionNo: a.admissionNo!, uhid };
  };
  const charge = (admissionId: string, sold: { medicineId: string; units: number; batchId?: string }[], k: string = key()) =>
    counterCharge(db, w.pharmacist, { idempotencyKey: k, admissionId, lines: sold }, { now: SALE_AT });

  it("a named batch then the same medicine by FEFO charges and takes exactly the units asked — never the named units twice", async () => {
    const r = await admitted();
    const med = await w.stocked("Exactol 500", { qty: 20 });
    const later = await addBatch(med.itemId, { qty: 20, expiry: "2031-06-30" });
    const sale = await charge(r.admissionId, [{ medicineId: med.medicineId, units: 5, batchId: later }, { medicineId: med.medicineId, units: 3 }]);
    const posted = await pharmacyLines(r.admissionId);
    expect(posted.reduce((t, l) => t + l.qty, 0)).toBe(8);
    expect(sale.lines.reduce((t, l) => t + l.units, 0)).toBe(8);
    expect([await onHand(med.batchId), await onHand(later)]).toEqual([17, 15]);
  });

  it("the same medicine twice in one sale, both from one batch: one sale, its units returnable in full", async () => {
    const r = await admitted();
    const med = await w.stocked("Twicol 500", { qty: 20 });
    const sale = await charge(r.admissionId, [{ medicineId: med.medicineId, units: 5 }, { medicineId: med.medicineId, units: 3 }]);
    expect((await pharmacyLines(r.admissionId)).reduce((t, l) => t + l.qty, 0)).toBe(8);
    expect(await onHand(med.batchId)).toBe(12);
    const listed = await readCounterSales(db, w.pharmacist, r.admissionId);
    expect(listed.sales.map((s) => s.lines.map((l) => [l.units, l.returned]))).toEqual([[[8, 0]]]);
    await counterReturn(db, w.pharmacist, { idempotencyKey: key(), saleId: sale.saleId, itemId: med.itemId, units: 2, reason: "Not needed" }, { now: ist("2026-03-11T12:00:00") });
    const after = await readCounterSales(db, w.pharmacist, r.admissionId);
    expect(after.sales.map((s) => s.lines.map((l) => [l.units, l.returned]))).toEqual([[[8, 2]]]);
    await counterReturn(db, w.pharmacist, { idempotencyKey: key(), saleId: sale.saleId, itemId: med.itemId, units: 6, reason: "Not needed" }, { now: ist("2026-03-11T12:30:00") });
    expect(await onHand(med.batchId)).toBe(20);
  });

  it("a named batch that has expired is never sold to an inpatient; nothing moves", async () => {
    const r = await admitted();
    const med = await w.stocked("Oldmox 500", { qty: 20 });
    const expired = await addBatch(med.itemId, { qty: 10, expiry: "2026-03-01" });
    expect(await codeOf(charge(r.admissionId, [{ medicineId: med.medicineId, units: 2, batchId: expired }]))).toBe("batch_mismatch");
    expect(await pharmacyLines(r.admissionId)).toEqual([]);
    expect(await onHand(expired)).toBe(10);
  });

  it("a sealed patient: the UHID finds no stay, and the IP number's answer carries no admission number, bed or ward", async () => {
    const r = await admitted();
    await db.update(patients).set({ sensitiveContext: true }).where(eq(patients.id, r.patientId));
    expect(await codeOf(lookupCounterAdmission(db, w.pharmacist, r.uhid, { now: SALE_AT }))).toBe("not_admitted");
    const byIp = await lookupCounterAdmission(db, w.pharmacist, r.admissionNo, { now: SALE_AT });
    expect([byIp.admissionId, byIp.identity.sealed, byIp.identity.uhid, byIp.admissionNo, byIp.bedCode, byIp.wardName]).toEqual([r.admissionId, true, "", null, null, null]);
  });

  it("a key the server already holds (in flight, or another body) answers 409 at the route, never a 500", async () => {
    const r = await admitted();
    const med = await w.stocked("Waitol 500", { qty: 20 });
    const k = key();
    const body = { idempotencyKey: k, admissionId: r.admissionId, lines: [{ medicineId: med.medicineId, units: 1 }] };
    await db.insert(idempotencyKeys).values({
      id: newId(), actorId: w.pharmacist.id, route: "ipd:counter_charge", key: k.toLowerCase(), requestHash: "a-different-attempt", state: "in_progress", claimedAt: SALE_AT,
    } as never);
    const ctrl = new IpdCounterController(db);
    const err = await ctrl.charge(w.pharmacist, body).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(409);
    expect(await pharmacyLines(r.admissionId)).toEqual([]);
  });
});
