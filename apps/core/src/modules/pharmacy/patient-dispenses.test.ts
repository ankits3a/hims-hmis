import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { phiAccessLog } from "../../kernel/db/schema";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { patientDispensesForDoctor } from "./patient-dispenses";
import { pickDispense } from "./pick";
import { declineLine, verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * CONSULT V2 — the refill record on the doctor's brief (`patientDispensesForDoctor`): only what the
 * counter HANDED OVER, declined lines dropped, one PHI row per read. Every dispense walks the real
 * counter path (the `summary.test.ts` flow): issue → claim → verify → pick → bill → hand over.
 */
describe("patientDispensesForDoctor — what the pharmacy handed over", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  const DAY_MS = 86_400_000;
  const READ_AT = new Date(MON.getTime() + 10 * DAY_MS);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", at: MON });
  });
  afterEach(() => { fx.unregister(); });

  /**
   * One prescription taken through the counter on day `day` (0 = MON). `stopAt: "billed"` leaves it
   * billed and uncollected; `declineIdx` declines that line before the verify.
   */
  async function dispense(
    day: number,
    lines: Parameters<typeof issueRx>[2],
    opts: { declineIdx?: number; stopAt?: "billed" } = {},
  ): Promise<{ dispenseId: string; prescriptionId: string; handedOverAt: Date }> {
    const at = new Date(MON.getTime() + day * DAY_MS);
    const t = (min: number) => new Date(at.getTime() + min * 60_000);
    const { issued } = await issueRx(db, fx, lines, { at });
    const found = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, t(20));
    if (found.kind !== "dispense") throw new Error("no dispense");
    const id = found.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, t(30));
    if (opts.declineIdx !== undefined) {
      await declineLine(db, fx.pharmacist.actor, fx.decls, id, opts.declineIdx, "out of stock", t(31));
    }
    const kept = lines.map((_, i) => i).filter((i) => i !== opts.declineIdx);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: kept.map((lineIdx) => ({ lineIdx, qtyBase: 10 })) }, t(32));
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, t(33));
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, t(34));
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, t(35));
    if (opts.stopAt !== "billed") await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, t(40));
    return { dispenseId: id, prescriptionId: issued.prescriptionId, handedOverAt: t(40) };
  }

  it("returns handed-over dispenses newest first, each line with its drug, prescribed days and quantity", async () => {
    const first = await dispense(0, [line({ drug: "Crocin 500", medicineId: fx.med.crocin, durationDays: 5 })]);
    const second = await dispense(2, [line({ drug: "Crocin 500", medicineId: fx.med.crocin, durationDays: 30 })]);

    const rows = await patientDispensesForDoctor(db, fx.doctor.actor, fx.patient.id, READ_AT);
    expect(rows).toEqual([
      { prescriptionId: second.prescriptionId, handedOverAt: second.handedOverAt.toISOString(), lines: [{ drug: "Crocin 500", durationDays: 30, qtyBase: 10 }] },
      { prescriptionId: first.prescriptionId, handedOverAt: first.handedOverAt.toISOString(), lines: [{ drug: "Crocin 500", durationDays: 5, qtyBase: 10 }] },
    ]);
  });

  it("a billed-but-uncollected dispense is not here, and a declined line is dropped", async () => {
    await dispense(0, [
      line({ drug: "Crocin 500", medicineId: fx.med.crocin }),
      line({ drug: "Azee 500", medicineId: fx.med.azithro }),
    ], { declineIdx: 1 });
    await dispense(2, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })], { stopAt: "billed" });

    const rows = await patientDispensesForDoctor(db, fx.doctor.actor, fx.patient.id, READ_AT);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lines.map((l) => l.drug)).toEqual(["Crocin 500"]);
  });

  it("writes one PHI access row under pharmacy.patient_dispenses, even when nothing was bought", async () => {
    expect(await patientDispensesForDoctor(db, fx.doctor.actor, fx.patient.id, READ_AT)).toEqual([]);
    const logged = await db.select().from(phiAccessLog).where(and(
      eq(phiAccessLog.surface, "pharmacy.patient_dispenses"), eq(phiAccessLog.actorId, fx.doctor.actor.id),
    ));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.patientId).toBe(fx.patient.id);
  });

  it("an unknown patient is refused as not_found", async () => {
    await expect(patientDispensesForDoctor(db, fx.doctor.actor, newId(), READ_AT))
      .rejects.toMatchObject({ code: "not_found" });
  });
});
