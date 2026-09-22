import { and, desc, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { mkPatient } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, pharmacyDispenses } from "../../kernel/db/schema";
import { prescriptionIssued } from "../opd";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense } from "./claim";
import { handlePrescriptionIssued } from "./consumers";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { listQueue } from "./queue";
import { counterSummary } from "./summary";
import { cancelDispense, verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * The queue at midnight. It listed only the tickets CREATED on the day asked for, so at 00:00 IST a
 * ticket the pharmacist was holding, and a ticket the patient had PAID for and not yet collected, fell
 * off the desk — the stock still reserved and the money still taken, with nothing on the screen to
 * say so. Measured on production 2026-09-20 00:10 IST: the desk was empty although a ticket was open.
 *
 * DECIDED (owner's standing rule, 2026-09-19 — the logical answer, a top hospital's standard):
 * - a ticket someone has started (claimed, verified, picked) or that is PAID (billed) stays on the
 *   queue until it is handed over or cancelled, whatever day it was queued;
 * - an untouched (queued) ticket stays for three days — today and the two before. An OPD prescription
 *   not collected in three days has almost always been filled elsewhere; it can still be found by
 *   scanning the prescription or by the UHID, it just stops crowding the live list.
 */
describe("the queue keeps open work across midnight", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  const TODAY = "2026-08-17";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", expiryDate: "2027-12-31", qtyBase: 200 });
  });
  afterEach(() => { fx.unregister(); });

  type State = "queued" | "claimed" | "picked" | "billed" | "handed_over" | "cancelled";
  const at = (m: number) => new Date(MON2.getTime() + m * 60_000);

  /**
   * A ticket as the worker makes one, walked to `state` by the counter's own functions (the table's
   * checks refuse a state without the order and invoice behind it), then dated to the day under test.
   */
  async function ticket(name: string, phone: string, queuedAt: string, state: State): Promise<string> {
    const p = await mkPatient(db, fx.clerk.actor, { name, phone });
    const { encounter } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })], { patientId: p.id });
    const [e] = await db.select({ eventId: events.eventId, payload: events.payload }).from(events)
      .where(and(eq(events.name, prescriptionIssued.name), eq(events.encounterId, encounter.id))).orderBy(desc(events.seq)).limit(1);
    const id = (await withTx(db, (tx) => handlePrescriptionIssued(tx, e!.eventId, e!.payload, MON2))).dispenseId!;
    if (state !== "queued") await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "token" }, at(1));
    if (state === "cancelled") await cancelDispense(db, fx.pharmacist.actor, fx.decls, id, "patient left before the check", at(2));
    if (state === "picked" || state === "billed" || state === "handed_over") {
      await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, at(2));
      await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, at(3));
    }
    if (state === "billed" || state === "handed_over") {
      const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, at(4));
      await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, at(4));
    }
    if (state === "handed_over") {
      await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "phone_last4", value: phone.slice(-4) } }, at(5));
    }
    await db.update(pharmacyDispenses).set({ createdAt: new Date(queuedAt) }).where(eq(pharmacyDispenses.id, id));
    return id;
  }

  it("started and paid tickets stay until they close; untouched ones stay three days", async () => {
    const today = await ticket("Today Queued", "9876500101", "2026-08-17T04:00:00.000Z", "queued");
    const yesterday = await ticket("Yesterday Queued", "9876500102", "2026-08-16T12:00:00.000Z", "queued");
    // 00:30 IST on the 15th is still the 15th in India, though it is the 14th in UTC
    const twoDays = await ticket("Two Days Queued", "9876500103", "2026-08-14T19:00:00.000Z", "queued");
    const threeDays = await ticket("Three Days Queued", "9876500104", "2026-08-14T12:00:00.000Z", "queued");
    const heldLastWeek = await ticket("Held Last Week", "9876500105", "2026-08-10T06:00:00.000Z", "claimed");
    const pickedLastWeek = await ticket("Picked Last Week", "9876500106", "2026-08-11T06:00:00.000Z", "picked");
    const paidLastWeek = await ticket("Paid Last Week", "9876500107", "2026-08-09T06:00:00.000Z", "billed");
    const closed = await ticket("Handed Over", "9876500108", "2026-08-16T06:00:00.000Z", "handed_over");
    const cancelled = await ticket("Cancelled", "9876500109", "2026-08-16T07:00:00.000Z", "cancelled");
    const tomorrow = await ticket("Tomorrow Queued", "9876500110", "2026-08-18T04:00:00.000Z", "queued");

    const ids = (await listQueue(db, fx.pharmacist.actor, { serviceDate: TODAY })).map((r) => r.dispenseId);
    expect(ids).toEqual([paidLastWeek, heldLastWeek, pickedLastWeek, twoDays, yesterday, today]);
    expect(ids).not.toContain(threeDays);
    expect(ids).not.toContain(closed);
    expect(ids).not.toContain(cancelled);
    expect(ids).not.toContain(tomorrow);
    // the header's open counts are the line's: the four-day-old untouched ticket and tomorrow's are in neither
    expect((await counterSummary(db, TODAY)).open).toEqual({ queued: 3, claimed: 1, verified: 0, picked: 1, billed: 1 });
  });

  it("each row says the IST day it was queued, so an earlier day's ticket is not read as today's", async () => {
    await ticket("Just After Midnight", "9876500102", "2026-08-16T20:00:00.000Z", "queued");
    const [row] = await listQueue(db, fx.pharmacist.actor, { serviceDate: TODAY });
    // 20:00 UTC on the 16th is 01:30 IST on the 17th — today, in India
    expect(row!.queuedOn).toBe("2026-08-17");
  });
});
