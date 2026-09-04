import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkUser } from "../../../test/helpers/opd";
import { withTx } from "../db/client";
import { printJobs } from "../db/schema";
import { DESTINATION_OF, enqueuePrintJob } from "./enqueue";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-24 T1 — THE PRINT OUTBOX
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * What these pin is not "a row is written" — that is trivially true and proves nothing. It is the
 * three properties the counter depends on and that would each fail silently:
 *
 *   · the enqueue RIDES THE CALLER'S TRANSACTION, so a visit that rolls back queues no slip;
 *   · a repeat inserts NOTHING and reports success, because a clerk who double-clicks has already
 *     got their paper coming and must not be told it failed;
 *   · the destination comes from the DOCUMENT, so no caller can send an A4 to a 72 mm roll.
 */
describe("FD-24 T1: the print outbox", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    clerk = await mkUser(db, "printing-clerk", []);
  });

  it("queues a job against the document's own destination, not the caller's choice", async () => {
    const id = await withTx(db, (tx) => enqueuePrintJob(tx, {
      document: "opd_token_slip",
      params: { encounterId: "e-1" },
      dedupeKey: "token:e-1",
      requestedBy: clerk.actor.id,
    }));
    expect(id).not.toBeNull();

    const rows = await db.select().from(printJobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      document: "opd_token_slip",
      destination: "front_desk_thermal",
      status: "queued",
      attempts: 0,
      dedupeKey: "token:e-1",
      requestedBy: clerk.actor.id,
    });
  });

  /**
   * OWNER RULING R2 — the prescription prints at the FRONT DESK, on its A4 laser, and NOT at the
   * vitals desk. The patient carries it into the consultation room. A table rather than an argument
   * is what makes that unforgettable.
   */
  it("every document has a destination, and the A4 sheet is the front desk's", () => {
    expect(DESTINATION_OF.opd_token_slip).toBe("front_desk_thermal");
    expect(DESTINATION_OF.opd_payment_receipt).toBe("front_desk_thermal");
    expect(DESTINATION_OF.opd_prescription).toBe("front_desk_a4"); // R2 — not the vitals desk
    expect(DESTINATION_OF.vitals_slip).toBe("vitals_thermal"); // R3 — its own printer
  });

  /**
   * THE DOUBLE-CLICK. A second enqueue on the same key writes nothing and returns null, and null is
   * SUCCESS — the paper is already coming. A caller that treated it as a failure would tell a clerk
   * the slip did not print while it was printing.
   */
  it("a repeat on the same dedupe key inserts nothing and does not raise", async () => {
    const first = await withTx(db, (tx) => enqueuePrintJob(tx, {
      document: "opd_token_slip", params: { encounterId: "e-1" }, dedupeKey: "token:e-1",
    }));
    const second = await withTx(db, (tx) => enqueuePrintJob(tx, {
      document: "opd_token_slip", params: { encounterId: "e-1" }, dedupeKey: "token:e-1",
    }));

    expect(first).not.toBeNull();
    expect(second).toBeNull(); // THE KILL for an enqueue that throws or writes a second slip
    expect(await db.select().from(printJobs)).toHaveLength(1);
  });

  /**
   * ═══ THE ONE THAT MATTERS: THE ENQUEUE RIDES THE CALLER'S TRANSACTION ═══
   *
   * A token slip queued for a visit that rolled back is a patient holding a number for a visit that
   * does not exist. Taking a `Tx` rather than a `Db` is what prevents it, and this is the row that
   * proves the signature is load-bearing rather than decorative.
   */
  it("a rolled-back caller queues NO slip", async () => {
    await expect(withTx(db, async (tx) => {
      await enqueuePrintJob(tx, {
        document: "opd_token_slip", params: { encounterId: "e-doomed" }, dedupeKey: "token:e-doomed",
      });
      throw new Error("the visit failed after the slip was queued");
    })).rejects.toThrow("the visit failed");

    // THE KILL for an enqueue that opened its own transaction or fired after the commit
    expect(await db.select().from(printJobs).where(eq(printJobs.dedupeKey, "token:e-doomed"))).toHaveLength(0);
  });

  it("a blank dedupe key is refused — it would be unique once and swallow every job after it", async () => {
    await expect(withTx(db, (tx) => enqueuePrintJob(tx, {
      document: "opd_token_slip", params: {}, dedupeKey: "   ",
    }))).rejects.toThrow(/dedupeKey/);
    expect(await db.select().from(printJobs)).toHaveLength(0);
  });
});
