import { eq, sql } from "drizzle-orm";
import { openSessionFor } from "../../../test/helpers/billing";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser, testCfg } from "../../../test/helpers/opd";
import { MON, MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  items, pharmacyColdExcursionBatches, pharmacyColdExcursionDecisions, pharmacyColdExcursions, stockWriteOffs,
} from "../../kernel/db/schema";
import { createStore, registerMaterialsApprovalTypes } from "../materials";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import {
  closeColdExcursion, coldChainToday, listColdExcursions, listColdUnits, recordColdReading, saveColdUnit, slotsOf,
} from "./cold-chain";
import { RETAIL_PHARMACY_STORE_CODE } from "./config";
import { PharmacyError } from "./errors";
import { handOverDispense } from "./handover";
import { buildNeeds } from "./office-needs";
import { pickDispense } from "./pick";
import { previewRetailSale, recordRetailLicence, sellRetail } from "./retail";
import { verifyDispense } from "./verify";
import type { Actor } from "@hmis/contracts";
import type { NeedInputs } from "./office-needs";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";

/**
 * ═══ PHARMACY STAGE D3 — THE FRIDGE LOG AND THE EXCURSION HOLD ═══
 *
 * What this stage must not get wrong:
 *   1. An out-of-range reading (any of current, min, max) opens ONE excursion in its own transaction, and freezes
 *      the store's cold batches on hand at that instant.
 *   2. While it is open, a held batch does not leave — not across the dispense counter, not across the walk-in
 *      counter — and the refusal names the fridge and says whom to call.
 *   3. The close decides every held batch; a written-off batch stays held.
 */
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { if (e instanceof PharmacyError) return e.code; throw e; }
  return "no refusal";
};

async function dbRefusal(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause;
    return cause?.message ?? (e as Error).message;
  }
  return "no refusal";
}

class NoDocs implements DocumentStore {
  async put(): Promise<void> {}
  async get(): Promise<Buffer> { throw new Error("none"); }
  async remove(): Promise<void> {}
}

/** 09:30 IST on MON is 04:00Z; the helpers' day. */
const at = (minutesAfterMon: number): Date => new Date(MON.getTime() + minutesAfterMon * 60_000);

describe("the fridge log and the excursion hold (pharmacy stage D3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let incharge: { id: string; actor: Actor };
  let unitId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "pharmacy.coldchain.record");
    await grantPermissionToRole(db, fx.registry, "pharmacy_assistant", "pharmacy.coldchain.record");
    await ensureRole(db, "pharmacy_incharge");
    for (const p of ["pharmacy.coldchain.manage", "materials.writeoffs.manage", "pharmacy.retail.manage"]) {
      await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", p);
    }
    incharge = await mkUser(db, "ph.cold.incharge", ["pharmacy_incharge"]);
    // Crocin stands in for a cold item (an insulin, a vaccine); Calpol stays ambient.
    await db.update(items).set({ storageClass: "cold_2_8" }).where(eq(items.id, fx.item.crocin));
    ({ unitId } = await saveColdUnit(db, incharge.actor, { storeResourceId: fx.storeId, label: "Vaccine fridge 1" }, at(-60)));
  });
  afterEach(() => { fx.unregister(); });

  const read = (currentC: number, minC: number, maxC: number, when = at(0), actor: Actor = fx.pharmacist.actor) =>
    recordColdReading(db, actor, { unitId, currentC, minC, maxC, takenAt: when }, when);

  it("an out-of-range reading opens ONE excursion, freezing the store's cold batches on hand; an in-range one opens none", async () => {
    const cold = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100 });
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CA-1", qtyBase: 100 });

    expect(await read(5.0, 3.1, 7.9)).toMatchObject({ outOfRange: false, opened: null });
    expect(await db.select().from(pharmacyColdExcursions)).toEqual([]);

    // The current is in range; the MAXIMUM since the reset is not — the door was left open overnight.
    const first = await read(5.2, 3.0, 9.4, at(5));
    expect(first).toMatchObject({ outOfRange: true, opened: { no: "CE-000001", batches: 1 } });
    expect(await db.select({ b: pharmacyColdExcursionBatches.batchId, q: pharmacyColdExcursionBatches.qtyOnHand }).from(pharmacyColdExcursionBatches))
      .toEqual([{ b: cold, q: 100 }]);

    // Stock that arrives after the excursion opened is not on its frozen list; a second bad reading opens nothing.
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-2", qtyBase: 10 });
    expect(await read(1.5, 1.5, 6.0, at(10))).toMatchObject({ outOfRange: true, opened: null });
    expect(await db.select().from(pharmacyColdExcursions)).toHaveLength(1);
    expect(await db.select().from(pharmacyColdExcursionBatches)).toHaveLength(1);

    const units = await listColdUnits(db, fx.pharmacist.actor, at(10));
    expect(units[0]).toMatchObject({ label: "Vaccine fridge 1", openExcursion: { no: "CE-000001", batches: 1 }, lastReading: { currentC: "1.5", outOfRange: true } });
  });

  it("refuses a reading that does not make sense, and a reader without the grant", async () => {
    expect(await refusal(read(5.0, 6.0, 7.0))).toBe("invalid_cold_chain"); // min above current
    expect(await refusal(read(5.05, 3.0, 7.0))).toBe("invalid_cold_chain"); // two decimals
    expect(await refusal(recordColdReading(db, fx.pharmacist.actor, { unitId, currentC: 5, minC: 3, maxC: 7, takenAt: at(10) }, at(0)))).toBe("invalid_cold_chain"); // future
    expect(await refusal(read(5.0, 3.0, 7.0, at(0), fx.clerk.actor))).toBe("permission_denied");
    expect(await refusal(saveColdUnit(db, fx.pharmacist.actor, { storeResourceId: fx.storeId, label: "Another" }))).toBe("permission_denied");
    expect(await refusal(saveColdUnit(db, incharge.actor, { id: unitId, label: "Vaccine fridge 1", lowC: 8, highC: 2 }))).toBe("invalid_cold_chain");
  });

  it("the log is append-only in the DATABASE: a reading, a held batch and an opened excursion refuse an edit", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100 });
    const { readingId } = await read(9.0, 3.0, 9.0);
    expect(await dbRefusal(db.execute(sql`update pharmacy_cold_readings set current_c = 5.0 where id = ${readingId}`))).toMatch(/pharmacy_cold_chain_immutable/);
    expect(await dbRefusal(db.execute(sql`delete from pharmacy_cold_readings where id = ${readingId}`))).toMatch(/pharmacy_cold_chain_immutable/);
    expect(await dbRefusal(db.execute(sql`delete from pharmacy_cold_excursion_batches`))).toMatch(/pharmacy_cold_chain_immutable/);
    expect(await dbRefusal(db.execute(sql`update pharmacy_cold_excursions set high_c = 12.0`))).toMatch(/pharmacy_cold_chain_immutable/);
    expect(await dbRefusal(db.execute(sql`delete from pharmacy_cold_units`))).toMatch(/pharmacy_cold_chain_immutable/);
  });

  describe("the hold at the dispense counter", () => {
    /** A Crocin prescription verified, picked and billed at `when`: ready to hand over. */
    async function billed(when: Date): Promise<string> {
      await openSessionFor(db, { id: fx.pharmacist.id }, 0);
      const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
      const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, when);
      if (r.kind !== "dispense") throw new Error("no dispense");
      const id = r.dispense.id;
      await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, when);
      await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, when);
      await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, when);
      const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, when);
      await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, when);
      return id;
    }

    it("refuses to hand over a frozen batch while the excursion is open, naming the fridge and the in-charge; a release lets it go", async () => {
      const batch = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100 });
      const id = await billed(MON2);
      await read(10.5, 3.0, 10.5, at(21));

      let caught: unknown;
      try { await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, at(22)); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(PharmacyError);
      expect((caught as PharmacyError).code).toBe("cold_chain_excursion_open");
      expect((caught as PharmacyError).message).toContain("Vaccine fridge 1");
      expect((caught as PharmacyError).message).toContain("pharmacy in-charge");

      const [ex] = await listColdExcursions(db, incharge.actor, { open: true });
      await closeColdExcursion(db, incharge.actor, ex!.id, { decisions: [{ batchId: batch, decision: "release", reason: "Manufacturer stability data: 72 h up to 25 °C" }] }, at(23));
      const handed = await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, at(24));
      expect(handed.status).toBe("handed_over");
    });

    it("a written-off batch stays held after the close; the write-off is the materials one, reason damage, awaiting the MS", async () => {
      await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
      const batch = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100 });
      const id = await billed(MON2);
      await read(0.4, 0.4, 6.0, at(21));
      const [ex] = await listColdExcursions(db, incharge.actor, { open: true });

      // Every held batch is decided, and only by the manage grant.
      expect(await refusal(closeColdExcursion(db, incharge.actor, ex!.id, { decisions: [] }, at(22)))).toBe("invalid_cold_chain");
      expect(await refusal(closeColdExcursion(db, incharge.actor, ex!.id, { decisions: [{ batchId: batch, decision: "release", reason: " " }] }, at(22)))).toBe("invalid_cold_chain");
      expect(await refusal(closeColdExcursion(db, fx.pharmacist.actor, ex!.id, { decisions: [{ batchId: batch, decision: "write_off" }] }, at(22)))).toBe("permission_denied");

      const closed = await closeColdExcursion(db, incharge.actor, ex!.id, { decisions: [{ batchId: batch, decision: "write_off" }], note: "froze overnight" }, at(22));
      expect(closed.writeOffId).not.toBeNull();
      const [wo] = await db.select().from(stockWriteOffs).where(eq(stockWriteOffs.id, closed.writeOffId!));
      expect(wo).toMatchObject({ reason: "damage", status: "requested", storeResourceId: fx.storeId });
      expect(await db.select({ d: pharmacyColdExcursionDecisions.decision }).from(pharmacyColdExcursionDecisions)).toEqual([{ d: "write_off" }]);
      expect(await refusal(closeColdExcursion(db, incharge.actor, ex!.id, { decisions: [{ batchId: batch, decision: "write_off" }] }, at(23)))).toBe("excursion_closed");

      expect(await refusal(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, at(24)))).toBe("cold_chain_excursion_open");
      expect((await listColdExcursions(db, incharge.actor))[0]).toMatchObject({ closed: { note: "froze overnight" }, batches: [{ batchNo: "CR-1", decision: { decision: "write_off" } }] });
    });
  });

  it("the walk-in counter refuses a frozen batch too", async () => {
    const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
    const { resourceId: retailId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" }));
    await recordRetailLicence(db, incharge.actor, {
      form20No: "RLF20-MH-PUN-1001", form21No: "RLF21-MH-PUN-1001", validFrom: "2026-01-01", validTo: "2030-12-31", pharmacistInCharge: "A. Kulkarni",
    }, MON);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "R-1", qtyBase: 50, resourceId: retailId });
    const { unitId: retailFridge } = await saveColdUnit(db, incharge.actor, { storeResourceId: retailId, label: "Retail fridge" }, at(-60));
    await recordColdReading(db, fx.pharmacist.actor, { unitId: retailFridge, currentC: 11.0, minC: 4.0, maxC: 11.0, takenAt: at(0) }, at(0));

    const lines = [{ medicineId: fx.med.crocin, qtyBase: 10 }];
    const p = await previewRetailSale(db, fx.pharmacist.actor, { lines }, at(1));
    const sale = sellRetail(db, new NoDocs(), fx.pharmacist.actor, {
      customer: { register: { name: "Ramesh Patil", sex: "male", ageYears: 52, phone: "9822001122" } },
      lines, tenders: [{ mode: "cash", amountPaise: p.totals.netPayablePaise }],
    }, undefined, at(1));
    let caught: unknown;
    try { await sale; } catch (e) { caught = e; }
    expect((caught as PharmacyError).code).toBe("cold_chain_excursion_open");
    expect((caught as PharmacyError).message).toContain("Retail fridge");
  });

  describe("the schedule: 09:00 and 17:00 IST, missed once 60 minutes past", () => {
    const DAY = "2026-08-17";
    const ist = (hhmm: string): Date => new Date(`${DAY}T${hhmm}:00+05:30`);
    const made = ist("06:00");

    it("done, due, missed, upcoming and not-due, measured on the pure slot function", () => {
      expect(slotsOf(DAY, [], made, ist("08:00")).map((s) => s.state)).toEqual(["upcoming", "upcoming"]);
      expect(slotsOf(DAY, [], made, ist("09:45")).map((s) => s.state)).toEqual(["due", "upcoming"]);
      expect(slotsOf(DAY, [], made, ist("10:01")).map((s) => s.state)).toEqual(["missed", "upcoming"]);
      expect(slotsOf(DAY, [{ id: "r", takenAt: ist("08:40") }], made, ist("17:30")).map((s) => s.state)).toEqual(["done", "due"]);
      expect(slotsOf(DAY, [{ id: "r", takenAt: ist("10:05") }], made, ist("18:30")).map((s) => s.state)).toEqual(["missed", "missed"]);
      expect(slotsOf(DAY, [], ist("12:00"), ist("18:30")).map((s) => s.state)).toEqual(["not_due", "missed"]);
    });

    it("the office's STOCK side: a missed reading amber, an open excursion red at tier 0", async () => {
      await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100 });
      // The fridge was added at 08:30 IST; nobody read it at 09:00; now it is 10:15.
      const today = await coldChainToday(db, incharge.actor, at(45));
      expect(today.missed).toEqual([{ unitId, label: "Vaccine fridge 1", storeCode: "PHARM-OPD", slot: "09:00", day: "2026-08-17" }]);
      await read(9.0, 3.0, 9.0, at(45));
      const after = await coldChainToday(db, incharge.actor, at(46));
      expect(after.open).toMatchObject([{ no: "CE-000001", label: "Vaccine fridge 1", batches: 1 }]);

      const empty: NeedInputs = { buy: null, pay: null, returns: null, grns: null, retail: null, cabinet: null, pharmacists: null, adr: null, incidents: null, cold: null, steward: null };
      const needs = buildNeeds({ ...empty, cold: today }, at(45));
      expect(needs.rows).toMatchObject([{ source: "STOCK", kind: "cold_reading_missed", clock: { tone: "gd" }, params: { label: "Vaccine fridge 1", slot: "09:00" } }]);
      expect(needs.sides).toContain("STOCK");
      const red = buildNeeds({ ...empty, cold: after }, at(46));
      expect(red.rows[0]).toMatchObject({ source: "STOCK", kind: "cold_excursion_open", tier: 0, clock: { tone: "rd" }, params: { no: "CE-000001", label: "Vaccine fridge 1" } });
    });
  });
});
