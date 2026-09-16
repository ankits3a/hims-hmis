import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { counterSummary } from "./summary";
import { declineLine, verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P7 — THE COUNTER'S DAY, IN ONE READ ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p7-counter-summary.md`: doc 16 §8's
 * KPIs and §14's 16f digest, first strip. Everything here is counted from the counter's own rows
 * and events for one IST day.
 */
describe("the counter's day (pharmacy P7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", at: MON });
  });
  afterEach(() => { fx.unregister(); });

  const CLAIM = new Date(MON2.getTime() + 10 * 60_000);
  async function claimed(lines: Parameters<typeof issueRx>[2]): Promise<string> {
    const { issued } = await issueRx(db, fx, lines);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, CLAIM);
    return r.dispense.id;
  }

  it("counts what the counter handed over, how long it took, what it declined and what is still open", async () => {
    // One handed over, with a declined line: Azee has no stock.
    const done = await claimed([line({ drug: "Crocin 500", medicineId: fx.med.crocin }), line({ drug: "Azee 500", medicineId: fx.med.azithro })]);
    await declineLine(db, fx.pharmacist.actor, fx.decls, done, 1, "out of stock", MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, done, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, done, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, done, MON2);
    await billDispense(db, fx.pharmacist.actor, done, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, done, {}, MON3);
    // One left at the claim.
    await claimed([line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);

    const s = await counterSummary(db, "2026-08-17");

    expect(s).toMatchObject({
      day: "2026-08-17",
      handedOver: 1,
      billedPaise: preview.totals.netPayablePaise,
      declinedLines: 1,
      declinedTop: [{ reason: "out of stock", lines: 1 }],
      substitutions: 0,
      cancelled: 0,
      refundedAfterBilling: 0,
      returns: 0,
      partlyCheckedLines: 0,
      scheduledHandovers: 0,
    });
    // The backlog is the five open states, exactly: a closed dispense never leaks into it.
    expect(s.open).toEqual({ queued: 0, claimed: 1, verified: 0, picked: 0, billed: 0 });
    // Queued at the scan (MON2), claimed ten minutes later, handed over at MON3: 20 and 10 minutes.
    expect([s.medianMinutes.queueToHandover, s.medianMinutes.claimToHandover]).toEqual([20, 10]);
    // Another day is another day.
    expect((await counterSummary(db, "2026-08-18")).handedOver).toBe(0);
  });

  it("refuses a day that is not a date", async () => {
    await expect(counterSummary(db, "17/08/2026")).rejects.toMatchObject({ code: "invalid_day" });
  });
});
