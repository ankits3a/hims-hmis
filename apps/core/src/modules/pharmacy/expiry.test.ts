import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { ensureRole, mkUser, testCfg } from "../../../test/helpers/opd";
import { approveRequest, rejectRequest } from "../../kernel/approvals/decisions";
import { requestApproval } from "../../kernel/approvals/requests";
import { withTx } from "../../kernel/db/client";
import { stockBalances, stockReservations } from "../../kernel/db/schema";
import { registerPharmacyApprovalTypes } from "./approval-types";
import { askDispenseDiscount, previewDispenseBill, billDispense } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { PICK_RESERVATION_MINUTES } from "./config";
import { PHARMACY_PICK_SWEEP_ACTOR, PICK_EXPIRED_REASON, sweepExpiredPicks } from "./expiry";
import { pickDispense } from "./pick";
import { getDispense } from "./queue";
import { cancelDispense, verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 16c CLOSE / F11 — the pick reservation expires, and the shelf gets its stock back.
 *
 * `pick.ts` wrote `expires_at` from the first commit and nothing read it, so these assertions are
 * about a promise (D2) that the shipped code did not keep: an abandoned pick held `qty_reserved`
 * for ever and the counter reported short stock on a full shelf.
 */
describe("the pick reservation expires (16c F11)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  const AFTER = new Date(MON2.getTime() + (PICK_RESERVATION_MINUTES + 1) * 60_000);
  const WITHIN = new Date(MON2.getTime() + (PICK_RESERVATION_MINUTES - 1) * 60_000);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", expiryDate: "2027-12-31", qtyBase: 100, mrpPaise: 12000 });
  });
  afterEach(() => { fx.unregister(); });

  async function picked(): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, {}, MON2);
    return r.dispense.id;
  }
  const reservedNow = async (): Promise<number> =>
    (await db.select().from(stockBalances)).reduce((n, b) => n + b.qtyReserved, 0);

  it("an abandoned pick past its window is cancelled and the ten tablets go back to the shelf", async () => {
    const id = await picked();
    expect(await reservedNow()).toBe(10);

    // inside the window the sweep leaves it alone — a pharmacist mid-transaction is not abandoned
    expect(await sweepExpiredPicks(db, fx.decls, WITHIN)).toEqual({ cancelled: [] });
    expect((await getDispense(db, fx.pharmacist.actor, id)).status).toBe("picked");
    expect(await reservedNow()).toBe(10);

    // past it, the stock is somebody else's again
    expect(await sweepExpiredPicks(db, fx.decls, AFTER)).toEqual({ cancelled: [id] });
    const after = await getDispense(db, fx.pharmacist.actor, id);
    expect(after.status).toBe("cancelled");
    expect(after.cancelReason).toContain("expired");
    expect(await reservedNow()).toBe(0);
    const [res] = await db.select().from(stockReservations);
    expect(res?.status).toBe("released");

    // and it is idempotent: a second pass has nothing left to do
    expect(await sweepExpiredPicks(db, fx.decls, AFTER)).toEqual({ cancelled: [] });
  });

  it("a BILLED dispense is never swept — the medicine is paid for and belongs to the patient", async () => {
    const id = await picked();
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);

    expect(await sweepExpiredPicks(db, fx.decls, AFTER)).toEqual({ cancelled: [] });
    expect((await getDispense(db, fx.pharmacist.actor, id)).status).toBe("billed");
    expect(await reservedNow()).toBe(10); // still held FOR this patient, not released to the shelf
    const [res] = await db.select().from(stockReservations).where(eq(stockReservations.status, "held"));
    expect(res).toBeDefined();
  });

  /**
   * ═══ A TICKET WAITING ON A DECISION IS NOT ABANDONED ═══
   *
   * The pharmacist picked, the patient asked for 15% off (the in-charge's tier) or for credit (the
   * owner's), and the counter is waiting for that person's answer. Cancelling at 30 minutes threw the
   * picked medicine back on the shelf and minted a new P-number when the answer came. While an approval
   * bound to the dispense is PENDING the sweep holds the ticket and renews its hold; once it is decided
   * (granted or rejected) the ordinary 30 minutes run again from the last renewal.
   */
  describe("while an approval bound to the ticket is pending", () => {
    const at = (m: number): Date => new Date(AFTER.getTime() + m * 60_000);
    const RENEWED_UNTIL = at(PICK_RESERVATION_MINUTES);
    let approver: { id: string; actor: Actor };

    beforeEach(async () => {
      await registerPharmacyApprovalTypes(db, fx.base.activator);
      await ensureRole(db, "pharmacy_incharge");
      approver = await mkUser(db, "ph.ic.approver", ["pharmacy_incharge"]);
    });

    const heldUntil = async (): Promise<Date[]> =>
      (await db.select().from(stockReservations).where(eq(stockReservations.status, "held"))).map((r) => r.expiresAt!);

    it("a pending discount holds the ticket and renews its hold; once granted, the 30 minutes run again", async () => {
      const id = await picked();
      const asked = await askDispenseDiscount(db, fx.pharmacist.actor, id, { kind: "percent_bps", value: 1500, reason: "staff family" }, MON2);

      expect(await sweepExpiredPicks(db, fx.decls, AFTER)).toEqual({ cancelled: [] });
      expect((await getDispense(db, fx.pharmacist.actor, id)).status).toBe("picked");
      expect(await reservedNow()).toBe(10);
      expect(await heldUntil()).toEqual([RENEWED_UNTIL]);

      await approveRequest(db, approver.actor, { approvalId: asked.approvalId, note: "agreed" });
      // decided: the renewed hold still runs to its end, then the ordinary sweep takes it
      expect(await sweepExpiredPicks(db, fx.decls, at(PICK_RESERVATION_MINUTES - 1))).toEqual({ cancelled: [] });
      expect(await sweepExpiredPicks(db, fx.decls, at(PICK_RESERVATION_MINUTES + 1))).toEqual({ cancelled: [id] });
      expect(await reservedNow()).toBe(0);
    });

    it("a pending owner credit holds the ticket; once rejected, the 30 minutes run again", async () => {
      const id = await picked();
      const { approvalId } = await withTx(db, (tx) => requestApproval(tx, fx.pharmacist.actor, {
        typeKey: "billing_credit_owner", subject: { type: "billing_credit", id },
        patientId: fx.patient.id, amountPaise: 12000, requestNote: "pays Friday",
      }));

      expect(await sweepExpiredPicks(db, fx.decls, AFTER)).toEqual({ cancelled: [] });
      expect(await heldUntil()).toEqual([RENEWED_UNTIL]);

      await rejectRequest(db, fx.base.owner, { approvalId, note: "no credit" });
      expect(await sweepExpiredPicks(db, fx.decls, at(PICK_RESERVATION_MINUTES + 1))).toEqual({ cancelled: [id] });
    });

    it("an approval pending for ANOTHER bill does not hold this one", async () => {
      const id = await picked();
      await withTx(db, (tx) => requestApproval(tx, fx.pharmacist.actor, {
        typeKey: "billing_credit_owner", subject: { type: "billing_credit", id: `${id}-other` },
        patientId: fx.patient.id, amountPaise: 12000, requestNote: "another bill",
      }));
      expect(await sweepExpiredPicks(db, fx.decls, AFTER)).toEqual({ cancelled: [id] });
    });
  });

  /**
   * ═══ PASS 2 — THE RACE THE SWEEP SAID IT HANDLED, AND DID NOT ═══
   *
   * `sweepExpiredPicks` swallows exactly one error, `PharmacyError("dispense_not_in_state")`, and
   * its comment justified that narrowness by pointing at the conditional UPDATE inside
   * `cancelDispense`. But that UPDATE ran AFTER the per-line loop, so a pharmacist cancelling the
   * same abandoned dispense — the ordinary end of an abandoned pick, not an exotic interleaving —
   * made the sweep lose inside `advanceOrderItem` instead, with `OrderError("stale_state")`. That
   * is not a `PharmacyError`: the filter rethrew, the tick aborted, and every remaining expired
   * pick in that batch waited another minute.
   *
   * Two cancellers on one dispense is the whole mechanism, and Postgres decides it for us: both
   * read `picked`, both enter their transaction, and the dispense row's lock serialises them. What
   * this pins is not WHO wins — it is that the loser fails as the pharmacy module's own
   * concurrency error, which is the contract the sweep's filter is written against.
   */
  it("two cancellers race on one abandoned pick: the loser fails as dispense_not_in_state, and the stock returns once", async () => {
    const id = await picked();
    expect(await reservedNow()).toBe(10);

    const results = await Promise.allSettled([
      cancelDispense(db, PHARMACY_PICK_SWEEP_ACTOR, fx.decls, id, PICK_EXPIRED_REASON, AFTER),
      cancelDispense(db, fx.pharmacist.actor, fx.decls, id, "patient never came back for it", AFTER),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    // the error the sweep is written to swallow — NOT OrderError("stale_state") from a child row
    expect((rejected[0]!.reason as { code?: string }).code).toBe("dispense_not_in_state");

    // one cancel, one release: the loser's whole transaction rolled back, so the ten tablets came
    // back to the shelf exactly once and `qty_reserved` was never double-decremented.
    expect((await getDispense(db, fx.pharmacist.actor, id)).status).toBe("cancelled");
    expect(await reservedNow()).toBe(0);
    const released = await db.select().from(stockReservations).where(eq(stockReservations.status, "released"));
    expect(released).toHaveLength(1);
    const [bal] = await db.select().from(stockBalances);
    expect(bal?.qtyOnHand).toBe(100);
  });
});
