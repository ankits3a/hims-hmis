import { and, eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { MON, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { pharmacyTrayChecks, stockBalances, stockLedger, transferLines, transfers } from "../../kernel/db/schema";
import { MaterialsError, setStoreCustodianRoles } from "../materials";
import { PharmacyError } from "./errors";
import { buildNeeds } from "./office-needs";
import {
  TRAY_CHECK_REF_TYPE, listTrayChecks, listTrays, receiveTrayRestock, recordTrayCheck, restockTrayCheck, saveTray, saveTrayTemplateLine,
  traysToday,
} from "./trays";
import type { Actor } from "@hmis/contracts";
import type { NeedInputs } from "./office-needs";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY STAGE D4 — THE EMERGENCY TRAYS ═══
 *
 * What this stage must not get wrong:
 *   1. The SERVER decides deficient — less than par present, an expiry inside 30 days, a daily seal that is not the
 *      one the tray was last sealed with — whatever the client thinks.
 *   2. "Restock from pharmacy" issues EXACTLY the deficit (par less present, plus the expiring) from PHARM-OPD to the
 *      tray through a materials transfer, once; the tray's keeper receives it.
 *   3. The register is append-only by trigger: a check changes only by its restock, once.
 *   4. Nobody checks a tray without `pharmacy.trays.check`.
 */
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { if (e instanceof PharmacyError || e instanceof MaterialsError) return e.code; throw e; }
  return "no refusal";
};

async function dbRefusal(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause;
    return cause?.message ?? (e as Error).message;
  }
  return "no refusal";
}

/** 09:30 IST on MON (a Monday, 17 Aug 2026) is 04:00Z. */
const at = (minutesAfterMon: number): Date => new Date(MON.getTime() + minutesAfterMon * 60_000);

describe("the emergency trays (pharmacy stage D4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let incharge: { id: string; actor: Actor };
  let nurse: { id: string; actor: Actor };
  let trayId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "pharmacy.trays.check");
    await ensureRole(db, "pharmacy_incharge");
    for (const p of ["pharmacy.trays.check", "pharmacy.trays.manage"]) await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", p);
    await ensureRole(db, "ot_nurse");
    await grantPermissionToRole(db, fx.registry, "ot_nurse", "pharmacy.trays.check");
    incharge = await mkUser(db, "ph.tray.incharge", ["pharmacy_incharge"]);
    nurse = await mkUser(db, "ot.sister", ["ot_nurse"]);
    // seed:pharmacy names the counter's keepers; the helpers' store has none until told.
    await withTx(db, (tx) => setStoreCustodianRoles(tx, { type: "system", id: "test" }, fx.storeId, ["pharmacy", "pharmacy_assistant"]));
    ({ trayId } = await saveTray(db, incharge.actor, { name: "OT-1 crash tray", location: "OT-1", custodianRoles: ["ot_nurse"] }, at(-600)));
    await saveTrayTemplateLine(db, incharge.actor, { trayId, itemId: fx.item.crocin, parQty: 10 }, at(-600));
    await saveTrayTemplateLine(db, incharge.actor, { trayId, itemId: fx.item.calpol, parQty: 5 }, at(-600));
  });
  afterEach(() => { fx.unregister(); });

  const full = (kind: "monthly_full" | "after_use", crocin: number, calpol: number, extra: { calpolExpiry?: string; calpolExpiring?: number; sealNew?: string } = {}, when = at(0), actor: Actor = nurse.actor) =>
    recordTrayCheck(db, actor, {
      trayId, kind, sealNew: extra.sealNew ?? "S-100",
      lines: [
        { itemId: fx.item.crocin, qtyPresent: crocin, earliestExpiry: "2027-06-30" },
        { itemId: fx.item.calpol, qtyPresent: calpol, earliestExpiry: extra.calpolExpiry ?? "2027-06-30", qtyExpiring: extra.calpolExpiring ?? null },
      ],
    }, when);

  it("the server decides deficient: short of par, an expiry inside 30 days, a daily seal that is not the last one", async () => {
    expect(await full("monthly_full", 10, 5)).toMatchObject({ no: "TC-000001", result: "ok", findings: [], deficit: 0 });
    // Short of par on one line.
    expect(await full("monthly_full", 8, 5, {}, at(1))).toMatchObject({ result: "deficient", findings: ["short"], deficit: 2 });
    // At par, but the calpol's earliest expiry is 20 days out (17 Aug -> 6 Sep): all five are to be replaced by default.
    expect(await full("monthly_full", 10, 5, { calpolExpiry: "2026-09-06" }, at(2))).toMatchObject({ result: "deficient", findings: ["expiring"], deficit: 5 });
    // 31 days out is outside the margin.
    expect(await full("monthly_full", 10, 5, { calpolExpiry: "2026-09-17" }, at(3))).toMatchObject({ result: "ok", findings: [] });

    // The daily seal: the tray was last sealed S-100 by the full check above.
    expect(await recordTrayCheck(db, nurse.actor, { trayId, kind: "daily_seal", sealSeen: "S-100" }, at(4))).toMatchObject({ result: "ok" });
    expect(await recordTrayCheck(db, nurse.actor, { trayId, kind: "daily_seal", sealSeen: "S-107" }, at(5))).toMatchObject({ result: "deficient", findings: ["seal_mismatch"], deficit: 0 });

    // Nothing the client sends decides the result: a full check that skips an item is refused, not marked ok.
    expect(await refusal(recordTrayCheck(db, nurse.actor, { trayId, kind: "monthly_full", lines: [{ itemId: fx.item.crocin, qtyPresent: 10 }] }, at(6)))).toBe("invalid_tray");
    expect(await refusal(recordTrayCheck(db, nurse.actor, { trayId, kind: "daily_seal" }, at(6)))).toBe("invalid_tray");
    // A seal mismatch is answered by a full check, not a restock.
    const [mismatch] = await db.select().from(pharmacyTrayChecks).where(eq(pharmacyTrayChecks.sealSeen, "S-107"));
    expect(await refusal(restockTrayCheck(db, fx.pharmacist.actor, mismatch!.id, at(7)))).toBe("invalid_tray");

    const trays = await listTrays(db, nurse.actor, at(8));
    expect(trays[0]).toMatchObject({ name: "OT-1 crash tray", location: "OT-1", daily: "done", monthly: "done", needsRestock: true, lastCheck: { no: "TC-000006", findings: ["seal_mismatch"] } });
  });

  it("restock issues exactly the deficit from PHARM-OPD through one transfer, once; the tray's keeper receives it", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100 });
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CA-1", qtyBase: 100 });
    // 7 of 10 crocin; 5 of 5 calpol, 2 of them inside the margin -> 3 + 2.
    const check = await full("monthly_full", 7, 5, { calpolExpiry: "2026-09-01", calpolExpiring: 2 });
    expect(check).toMatchObject({ result: "deficient", findings: ["short", "expiring"], deficit: 5 });

    // The nurse keeps the tray, not the pharmacy's shelf: she may not issue from PHARM-OPD.
    expect(await refusal(restockTrayCheck(db, nurse.actor, check.checkId, at(5)))).toBe("permission_denied");
    const out = await restockTrayCheck(db, fx.pharmacist.actor, check.checkId, at(5));
    expect(out.units).toBe(5);
    const [t] = await db.select().from(transfers).where(eq(transfers.id, out.transferId));
    expect(t).toMatchObject({ fromResourceId: fx.storeId, toResourceId: trayId, status: "in_transit" });
    const lines = await db.select({ batchId: transferLines.batchId, qty: transferLines.qtyIssued }).from(transferLines).where(eq(transferLines.transferId, out.transferId));
    const issued = new Map<string, number>();
    for (const l of lines) issued.set(l.batchId, (issued.get(l.batchId) ?? 0) + l.qty);
    expect([...issued.values()].sort()).toEqual([2, 3]);
    const shelf = await db.select({ q: stockBalances.qtyOnHand }).from(stockBalances).where(eq(stockBalances.resourceId, fx.storeId));
    expect(shelf.map((s) => s.q).sort()).toEqual([97, 98]);
    const [row] = await db.select().from(pharmacyTrayChecks).where(eq(pharmacyTrayChecks.id, check.checkId));
    expect(row).toMatchObject({ restockTransferId: out.transferId, restockedBy: fx.pharmacist.id });

    expect(await refusal(restockTrayCheck(db, fx.pharmacist.actor, check.checkId, at(6)))).toBe("tray_already_restocked");
    // The issuer does not sign for it; the tray's keeper does.
    expect(await refusal(receiveTrayRestock(db, fx.pharmacist.actor, check.checkId, {}, at(7)))).toBe("transfer_self_receipt");
    expect(await receiveTrayRestock(db, nurse.actor, check.checkId, {}, at(8))).toEqual({ status: "received" });
    const tray = await db.select({ q: stockBalances.qtyOnHand }).from(stockBalances).where(eq(stockBalances.resourceId, trayId));
    expect(tray.map((s) => s.q).sort()).toEqual([2, 3]);

    const history = await listTrayChecks(db, incharge.actor, trayId);
    expect(history[0]).toMatchObject({ no: "TC-000001", restock: { transferId: out.transferId, status: "received" }, restockedByName: "ph.mehta" });
    expect(history[0]!.lines.map((l) => [l.qtyPresent, l.qtyExpiring, l.qtyRestock])).toEqual([[5, 2, 2], [7, 0, 3]]);
  });

  it("an after-use check takes what left the tray off its ledger as consumption, and names the patient", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-T", qtyBase: 10, resourceId: trayId });
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CA-T", qtyBase: 5, resourceId: trayId });
    const out = await recordTrayCheck(db, nurse.actor, {
      trayId, kind: "after_use", patientId: fx.patient.id, event: "code blue OPD 2",
      lines: [{ itemId: fx.item.crocin, qtyPresent: 6 }, { itemId: fx.item.calpol, qtyPresent: 5 }],
    }, at(0));
    expect(out).toMatchObject({ result: "deficient", findings: ["short"], consumed: 4, deficit: 4 });
    const used = await db.select().from(stockLedger).where(and(eq(stockLedger.refType, TRAY_CHECK_REF_TYPE), eq(stockLedger.refId, out.checkId)));
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ resourceId: trayId, qtyDelta: -4, reason: "consume", patientId: fx.patient.id });
    // Only an after-use check names a patient.
    expect(await refusal(recordTrayCheck(db, nurse.actor, { trayId, kind: "daily_seal", sealSeen: "S-1", patientId: fx.patient.id }, at(1)))).toBe("invalid_tray");
  });

  it("the register is append-only: a check changes only by its restock, once; lines and templates are never deleted", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100 });
    const check = await full("monthly_full", 7, 5);
    expect(await dbRefusal(db.execute(sql`update pharmacy_tray_checks set result = 'ok' where id = ${check.checkId}`))).toMatch(/pharmacy_tray_immutable/);
    expect(await dbRefusal(db.execute(sql`delete from pharmacy_tray_checks where id = ${check.checkId}`))).toMatch(/pharmacy_tray_immutable/);
    expect(await dbRefusal(db.execute(sql`update pharmacy_tray_check_lines set qty_present = 10 where check_id = ${check.checkId}`))).toMatch(/pharmacy_tray_immutable/);
    expect(await dbRefusal(db.execute(sql`delete from pharmacy_tray_check_lines where check_id = ${check.checkId}`))).toMatch(/pharmacy_tray_immutable/);
    expect(await dbRefusal(db.execute(sql`delete from pharmacy_tray_templates where tray_resource_id = ${trayId}`))).toMatch(/pharmacy_tray_immutable/);
    expect(await dbRefusal(db.execute(sql`update pharmacy_tray_templates set item_id = ${fx.item.azithro} where tray_resource_id = ${trayId} and item_id = ${fx.item.crocin}`))).toMatch(/pharmacy_tray_immutable/);

    const { transferId } = await restockTrayCheck(db, fx.pharmacist.actor, check.checkId, at(5));
    // The restock is set once; it is not moved to another transfer afterwards.
    expect(await dbRefusal(db.execute(sql`update pharmacy_tray_checks set restocked_at = now() where id = ${check.checkId}`))).toMatch(/pharmacy_tray_immutable/);
    const [row] = await db.select().from(pharmacyTrayChecks).where(eq(pharmacyTrayChecks.id, check.checkId));
    expect(row!.restockTransferId).toBe(transferId);
  });

  it("refuses a check without pharmacy.trays.check, and a tray or list change without pharmacy.trays.manage", async () => {
    expect(await refusal(recordTrayCheck(db, fx.clerk.actor, { trayId, kind: "daily_seal", sealSeen: "S-1" }, at(0)))).toBe("permission_denied");
    expect(await refusal(full("monthly_full", 10, 5, {}, at(0), fx.clerk.actor))).toBe("permission_denied");
    expect(await refusal(listTrays(db, fx.clerk.actor, at(0)))).toBe("permission_denied");
    expect(await refusal(saveTray(db, nurse.actor, { name: "Another", location: "CT room", custodianRoles: ["radiographer"] }))).toBe("permission_denied");
    expect(await refusal(saveTrayTemplateLine(db, fx.pharmacist.actor, { trayId, itemId: fx.item.azithro, parQty: 2 }))).toBe("permission_denied");
    // Nothing was written by the refused check.
    expect(await db.select().from(pharmacyTrayChecks)).toEqual([]);
    // A tray is kept by those who check it.
    expect(await refusal(saveTray(db, incharge.actor, { name: "CT tray", location: "CT room", custodianRoles: ["front_office"] }))).toBe("invalid_tray");
  });

  it("the office's STOCK side: a deficient tray red until restocked, a daily check missed after 10:00, tray stock inside 30 days", async () => {
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CA-SHORT", qtyBase: 3, resourceId: trayId, expiryDate: "2026-09-01" });
    // 09:30 IST: the daily check is still due; nothing missed yet.
    let today = await traysToday(db, nurse.actor, at(0));
    expect(today.dailyMissed).toEqual([]);
    expect(today.expiring).toEqual([expect.objectContaining({ name: "OT-1 crash tray", batchNo: "CA-SHORT", expiryDate: "2026-09-01", qty: 3 })]);
    // 10:31 IST and still no check: missed.
    today = await traysToday(db, nurse.actor, at(61));
    expect(today.dailyMissed).toEqual([expect.objectContaining({ trayId, name: "OT-1 crash tray" })]);

    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100 });
    const check = await full("monthly_full", 7, 5, {}, at(62));
    today = await traysToday(db, nurse.actor, at(63));
    expect(today.dailyMissed).toEqual([]);
    expect(today.deficient).toEqual([expect.objectContaining({ trayId, no: check.no })]);
    const empty: NeedInputs = { buy: null, pay: null, returns: null, grns: null, retail: null, cabinet: null, pharmacists: null, adr: null, incidents: null, cold: null, steward: null, trays: null };
    const needs = buildNeeds({ ...empty, trays: today }, at(63));
    expect(needs.sides).toEqual(["STOCK"]);
    expect(needs.rows.map((r) => [r.kind, r.tier])).toEqual([["tray_deficient", 0], ["tray_expiring", 6]]);

    await restockTrayCheck(db, fx.pharmacist.actor, check.checkId, at(64));
    today = await traysToday(db, nurse.actor, at(65));
    expect(today.deficient).toEqual([]);
  });

  it("the monthly full check is due by the 7th (IST); a tray set up after that is not due this month", async () => {
    // 8 Sep 2026, 12:00 IST: no full check this month on a tray set up in August.
    const sep8 = new Date("2026-09-08T06:30:00.000Z");
    let today = await traysToday(db, nurse.actor, sep8);
    expect(today.monthlyMissed).toEqual([expect.objectContaining({ trayId, month: "2026-09" })]);
    await full("monthly_full", 10, 5, {}, sep8);
    today = await traysToday(db, nurse.actor, new Date(sep8.getTime() + 60_000));
    expect(today.monthlyMissed).toEqual([]);
  });
});
