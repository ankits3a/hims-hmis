import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { ipdAdmissionPackages, ipdChargeLines, ipdEmarLabels, ipdSchemePackages, transfers } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkWardSafetyWorld } from "../../../test/helpers/ipd";
import { balances } from "../materials";
import { admissionPlace } from "./admission-place";
import {
  issueMed, placeIpOrder, readAgencyNurses, recordWardStockUse, returnWardLots, secondCheck, setWardPar, verifyNurseRegistration, verifyOrder,
} from "./index";
import { IpdError, IpdRefusal } from "./errors";
import type { Db } from "../../kernel/db/client";
import type { WardSafetyWorld } from "../../../test/helpers/ipd";

/**
 * WM-2 follow-ups (#1009, #1010). Explicit IST instants; every name is made up.
 * - #1010: a ward-stock item on an admission with a live scheme package is never charged separately (decision 0091
 *   rule 1); expiring or expired lots go back from the ward's store to its supply store as one materials transfer.
 * - #1009: an agency nurse witnesses a second check only with a council registration verified and in date (0089 rule 5).
 */
jest.setTimeout(300_000);

const at = (day: number, hhmm: string): Date => new Date(`2026-03-${String(day).padStart(2, "0")}T${hhmm}:00+05:30`);
const key = (): string => randomUUID();
const TICKS = { allergy: true, interaction: true, dose: true, duplicate: true };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof IpdError || e instanceof IpdRefusal) return e.code; throw e; }
  throw new Error("expected a refusal");
}

describe("ward follow-ups (#1009, #1010)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: WardSafetyWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkWardSafetyWorld(db); });

  it("#1010: an admission on a scheme package is never charged for ward stock; the use is recorded as in package", async () => {
    const { admissionId } = await w.admitMed(at(10, "08:00"));
    const wardId = (await admissionPlace(db, admissionId))!.wardId!;
    const pad = await w.wardItem("Dressing pad");
    const par = await setWardPar(db, w.incharge, { idempotencyKey: key(), wardId, supplyStoreId: w.centralStoreId, items: [{ itemId: pad.itemId, par: 10 }] }, { now: at(10, "08:30") });
    const lot = await w.lot(pad.itemId, par.storeId, 10, "2027-06-30");
    const pkgId = newId();
    await db.insert(ipdSchemePackages).values({
      id: pkgId, scheme: "pmjay", code: "MG001A", name: "Synthetic medical package", specialty: "General Medicine", kind: "medical", ratePaise: 1_800_000,
      preauthRequired: false, importBatch: "test", importedBy: "t", importedAt: at(1, "08:00"),
    });
    await db.insert(ipdAdmissionPackages).values({
      id: newId(), admissionId, packageId: pkgId, code: "MG001A", name: "Synthetic medical package", ratePaise: 1_800_000, selectedBy: "t", selectedAt: at(10, "08:10"),
    });
    const used = await recordWardStockUse(db, w.nurse, { idempotencyKey: key(), admissionId, itemId: pad.itemId, batchId: lot, qty: 2, outcome: "used" }, { now: at(10, "09:00") });
    expect(used).toMatchObject({ charged: false, notChargedWhy: "in_package" });
    expect(await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.issueId, used.useId))).toHaveLength(0);
  });

  it("#1010: the in-charge sends expiring lots back to the supply store as one transfer; a good lot stays", async () => {
    const { admissionId } = await w.admitMed(at(10, "08:00"));
    const wardId = (await admissionPlace(db, admissionId))!.wardId!;
    const pad = await w.wardItem("Dressing pad");
    const par = await setWardPar(db, w.incharge, { idempotencyKey: key(), wardId, supplyStoreId: w.centralStoreId, items: [{ itemId: pad.itemId, par: 10 }] }, { now: at(10, "08:30") });
    const soon = await w.lot(pad.itemId, par.storeId, 3, "2026-03-25");
    const old = await w.lot(pad.itemId, par.storeId, 2, "2026-02-28");
    const good = await w.lot(pad.itemId, par.storeId, 5, "2027-06-30");
    expect(await codeOf(returnWardLots(db, w.nurse, { idempotencyKey: key(), wardId }, { now: at(10, "09:00") }))).toBe("ipd_forbidden");
    const r = await returnWardLots(db, w.incharge, { idempotencyKey: key(), wardId }, { now: at(10, "09:05") });
    expect(r.lines).toBe(2);
    expect((await db.select().from(transfers).where(eq(transfers.id, r.transferId)))[0]).toMatchObject({ fromResourceId: par.storeId });
    const left = async (batchId: string) => (await balances(db, { resourceId: par.storeId, batchId }))[0]?.qtyOnHand ?? 0;
    expect([await left(soon), await left(old), await left(good)]).toEqual([0, 0, 5]);
    expect(await codeOf(returnWardLots(db, w.incharge, { idempotencyKey: key(), wardId }, { now: at(10, "09:10") }))).toBe("nothing_to_return");
  });

  it("#1009: an agency nurse witnesses a second check only with a verified, in-date council registration", async () => {
    const { admissionId } = await w.admitMed(at(10, "10:00"));
    const med = await w.stocked("Heparin 5000 IU inj", { highAlert: true, form: "injection", strength: "5000 IU", baseUom: "vial" });
    const placed = await placeIpOrder(db, w.consultant, {
      idempotencyKey: key(), admissionId, kind: "drug",
      drug: { itemId: med.medicineId, dose: { value: 5000, unit: "iu" }, route: "sc", frequency: "BD", startAt: at(11, "07:00").toISOString(), antibiotic: false, durationDays: 5 },
    }, { now: at(11, "07:00") });
    await verifyOrder(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, decision: "verified", checks: TICKS, note: "checked" }, { now: at(11, "07:30") });
    const issued = await issueMed(db, w.pharmacist, { idempotencyKey: key(), orderId: placed.orderId, units: 4, ownMedicine: false }, { now: at(11, "07:40") });
    expect((await db.select().from(ipdEmarLabels).where(eq(ipdEmarLabels.issueId, issued.issueId))).length).toBeGreaterThan(0);
    const witness = (now: Date) => secondCheck(db, w.nurse, {
      idempotencyKey: key(), purpose: "high_alert_dose", orderId: placed.orderId, username: w.agencyPin.username, pin: w.agencyPin.pin, doseDueAt: at(11, "09:00").toISOString(),
    }, { now });

    expect(await codeOf(witness(at(11, "09:00")))).toBe("agency_witness_unverified");
    const agencyId = w.agency.id;
    expect((await readAgencyNurses(db, w.superintendent, { now: at(11, "09:01") })).nurses).toMatchObject([{ userId: agencyId, registration: null, canWitness: false }]);
    expect(await codeOf(verifyNurseRegistration(db, w.nurse, {
      idempotencyKey: key(), userId: agencyId, council: "Bihar Nurses Registration Council", registrationNo: "BNRC-0001", validUntil: "2027-12-31",
    }, { now: at(11, "09:02") }))).toBe("ipd_forbidden");
    await verifyNurseRegistration(db, w.superintendent, {
      idempotencyKey: key(), userId: agencyId, council: "Bihar Nurses Registration Council", registrationNo: "BNRC-0001", validUntil: "2026-03-20",
    }, { now: at(11, "09:03") });
    expect(await witness(at(11, "09:05"))).toMatchObject({ userId: agencyId });
    expect((await readAgencyNurses(db, w.superintendent, { now: at(11, "09:06") })).nurses[0]).toMatchObject({ canWitness: true, registration: { registrationNo: "BNRC-0001" } });
    // Past its validity, the registration no longer lets her witness.
    expect(await codeOf(witness(at(21, "09:00")))).toBe("agency_witness_unverified");
  });
});
