import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { patients, phiAccessLog, rolePermissions } from "../../kernel/db/schema";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { h1Register } from "./registers";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P9 — THE SCHEDULE H1 REGISTER, READ ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p9-h1-register.md`. Drugs and
 * Cosmetics Rules 1945 r.65(3A): the register records the prescriber, the patient, the drug and the
 * quantity; it is kept for three years and produced to an inspector. Hand-over has written it since
 * 16c. Until now nothing read it.
 */
describe("the Schedule H1 register (pharmacy P9)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", expiryDate: "2027-06-30", qtyBase: 30, mrpPaise: 15000 });
    await db.update(patients).set({ addressLine: "12 MG Road, Pune" }).where(eq(patients.id, fx.patient.id));
  });
  afterEach(() => { fx.unregister(); });

  /** Three Azee 500 (Schedule H1) handed over by the registered pharmacist at MON3, 2026-08-17 IST. */
  async function handedOverH1(): Promise<void> {
    const { issued, tokenNo } = await issueRx(db, fx, [line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    const id = r.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "token", value: String(tokenNo) } }, MON3);
  }

  const accessRows = () => db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "pharmacy.h1_register"));

  it("gives the period's entries with what the Rule asks for, oldest first, and logs one access per patient shown", async () => {
    await handedOverH1();
    await handedOverH1();
    const [person] = await db.select().from(patients).where(eq(patients.id, fx.patient.id));

    const reg = await h1Register(db, fx.pharmacist.actor, { from: "2026-08-17", to: "2026-08-17" });

    expect(reg.period).toEqual({ from: "2026-08-17", to: "2026-08-17" });
    expect(reg.rows).toHaveLength(2);
    expect(reg.rows[0]!.entryNo).toBeLessThan(reg.rows[1]!.entryNo);
    expect(reg.rows.slice(0, 1)).toEqual([{
      entryNo: expect.any(Number),
      dispensedAt: MON3.toISOString(),
      patientId: fx.patient.id,
      patientName: person!.name,
      patientAddress: "12 MG Road, Pune",
      restricted: false,
      prescriberName: expect.any(String),
      prescriberRegNo: expect.anything(),
      drugName: "Azee 500 500 mg tablet",
      batchNo: "AZ-1",
      qtyBase: 3,
      unit: "tablet",
      pharmacistRegNo: "MSPC-123456",
    }]);
    const logged = await accessRows();
    expect(logged.map((r) => [r.actorId, r.patientId])).toEqual([[fx.pharmacist.id, fx.patient.id]]);

    // The next day holds nothing, and an empty read discloses nobody.
    expect((await h1Register(db, fx.pharmacist.actor, { from: "2026-08-18", to: "2026-09-17" })).rows).toEqual([]);
    expect(await accessRows()).toHaveLength(1);
  });

  it("withholds a sealed patient's name and address from a reader without clearance, says so, and shows them to one with it", async () => {
    await handedOverH1();
    const [person] = await db.select().from(patients).where(eq(patients.id, fx.patient.id));
    await db.update(patients).set({ isConfidential: true, alias: "Patient R-17" }).where(eq(patients.id, fx.patient.id));

    const [row] = (await h1Register(db, fx.pharmacist.actor, { from: "2026-08-01", to: "2026-08-31" })).rows;

    expect(row).toMatchObject({ patientName: "Patient R-17", patientAddress: null, restricted: true, drugName: "Azee 500 500 mg tablet" });
    const [logged] = await accessRows();
    expect(logged?.sealed).toBe(true);

    // The inspector's unredacted copy is a named grant: the register's own (P17)…
    await db.insert(rolePermissions).values({ roleKey: "pharmacy", permission: "pharmacy.register.read_sealed" });
    const [viaRegister] = (await h1Register(db, fx.pharmacist.actor, { from: "2026-08-01", to: "2026-08-31" })).rows;
    expect(viaRegister).toMatchObject({ patientName: person!.name, patientAddress: "12 MG Road, Pune", restricted: false });
    const sealedReads = (await accessRows()).filter((r) => r.sealed);
    expect(sealedReads).toHaveLength(2);
    // …or the hospital-wide one.
    await db.delete(rolePermissions).where(eq(rolePermissions.permission, "pharmacy.register.read_sealed"));
    await db.insert(rolePermissions).values({ roleKey: "pharmacy", permission: "patients.confidential.read" });
    const [cleared] = (await h1Register(db, fx.pharmacist.actor, { from: "2026-08-01", to: "2026-08-31" })).rows;
    expect(cleared).toMatchObject({ patientName: person!.name, patientAddress: "12 MG Road, Pune", restricted: false });
  });

  it("is the register reader's alone, and refuses a period that is not one month or less of real dates", async () => {
    await expect(h1Register(db, fx.aide.actor, { from: "2026-08-01", to: "2026-08-31" })).rejects.toMatchObject({ code: "permission_denied" });
    for (const [from, to] of [["2026-08-01", "01/09/2026"], ["2026-08-31", "2026-08-01"], ["2026-08-01", "2026-09-01"], ["2026-02-30", "2026-03-05"]] as const) {
      await expect(h1Register(db, fx.pharmacist.actor, { from, to })).rejects.toMatchObject({ code: "invalid_range" });
    }
    expect(await accessRows()).toHaveLength(0);
  });
});
