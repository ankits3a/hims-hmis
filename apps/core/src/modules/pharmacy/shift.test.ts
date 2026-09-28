import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantDrawerSupervisor, openSessionFor, submitCountFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { ensureRole, testCfg } from "../../../test/helpers/opd";
import { assignRole } from "../../kernel/auth/permissions";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { myShift } from "./shift";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P1 — "SALES TODAY", THE PHARMACIST'S OWN SHIFT ═══
 *
 * The desk's idle rail ("your day") reads the counter's hand-overs AND this person's money: what
 * they handed over, what they took by tender, and what their drawer should hold — the billing desk
 * card's own figures, not a second arithmetic.
 */
describe("the pharmacist's shift (pharmacy P1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", at: MON });
  });
  afterEach(() => { fx.unregister(); });

  async function sold(mode: "cash" | "upi"): Promise<number> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    const id = r.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode, amountPaise: preview.totals.netPayablePaise, ...(mode === "upi" ? { refText: "UTR-0001" } : {}) }] }, MON2);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON3);
    return preview.totals.netPayablePaise;
  }

  it("says what this pharmacist handed over and took, by tender, and her open drawer — but not what it should hold (blind count)", async () => {
    await openSessionFor(db, { id: fx.pharmacist.id }, 50_000);
    const cash = await sold("cash");
    const upi = await sold("upi");

    const s = await myShift(db, fx.pharmacist.actor, MON3);
    expect(s).toMatchObject({
      day: "2026-08-17",
      handedOver: 2,
      takenPaise: cash + upi,
      byMode: { cash, upi, card: 0 },
      returns: 0,
      refunds: 0,
      drawer: { status: "open", openingFloatPaise: 50_000 },
    });
    // OWNER RULING 2026-09-28 — BLIND COUNT: her drawer is open and uncounted, so what it should
    // hold is not in the response at all — not zero, not null, ABSENT.
    expect(s.drawer).not.toHaveProperty("expectedCashPaise");
  });

  it("blind count: once her count is submitted, the drawer's holder reads the expected cash again", async () => {
    await openSessionFor(db, { id: fx.pharmacist.id }, 50_000);
    const cash = await sold("cash");
    // after her count (short → closing) the figure is hers again
    expect(await submitCountFor(db, fx.pharmacist, { "10000": 1 })).toEqual({ status: "closing" });
    expect((await myShift(db, fx.pharmacist.actor, MON3)).drawer).toMatchObject({ status: "closing", expectedCashPaise: 50_000 + cash });
  });

  it("blind count: a pharmacist who ALSO supervises drawers sees her open drawer's expected cash", async () => {
    await ensureRole(db, "blind_supervisor_t");
    await grantDrawerSupervisor(db, "blind_supervisor_t");
    await assignRole(db, { userId: fx.pharmacist.id, roleKey: "blind_supervisor_t", scopeType: "hospital" });
    await openSessionFor(db, { id: fx.pharmacist.id }, 50_000);
    const cash = await sold("cash");
    expect((await myShift(db, fx.pharmacist.actor, MON3)).drawer).toMatchObject({ status: "open", expectedCashPaise: 50_000 + cash });
  });

  it("is somebody else's nothing: another login at the same counter sees its own zeros and no drawer", async () => {
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await sold("cash");
    const s = await myShift(db, fx.aide.actor, MON3);
    expect(s).toMatchObject({ handedOver: 0, takenPaise: 0, byMode: { cash: 0, upi: 0, card: 0 }, drawer: null });
  });
});
