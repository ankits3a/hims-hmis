import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { setupPcpndtFixture } from "../../../test/helpers/pcpndt";
import { pcpndtFormF, pcpndtFormFSerials } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { openFormF } from "./form-f";
import type { PcpndtFixture } from "../../../test/helpers/pcpndt";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T6 — Assertion Book row **A1**, and it is its own file because a race needs real
 * concurrent transactions and a single-connection suite cannot produce one.
 *
 * ═══ WHAT IS ACTUALLY BEING TESTED ═══
 *
 * Not "does `openFormF` allocate a number" — a read-then-write counter passes that reading of the
 * requirement and hands two women's forms the same serial. What is tested is that the SERIAL COMES
 * FROM THE DATABASE'S COUNTER: `INSERT … ON CONFLICT DO NOTHING` for the cold start, then one
 * `UPDATE … SET next_no = next_no + 1 … RETURNING`, whose row lock serialises every concurrent
 * caller on `(machine_id, year)`.
 *
 * **This is the property the whole Act turns on.** A register with a duplicate serial is a register
 * an inspector disbelieves in its entirety, and I6's harm is found by counting rather than by
 * reading — which is why the assertion counts.
 *
 * ═══ NO HELD TRANSACTION IS NEEDED HERE, UNLIKE 18a T5's A7 (F21) ═══
 *
 * T5's gate race had to hold each transaction open past the other's pre-read, because its subject
 * was a compare-and-set that a serialised pair would never reach. This one needs no such
 * construction: the contention is a ROW LOCK on the counter, every caller must take it, and there
 * is no pre-read in front of it to short-circuit. The two tests look similar and are not — the
 * difference is whether the mechanism can be bypassed by lucky ordering.
 */
describe("the Form F serial is gap-free because the DATABASE counts (18a T6 A1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PcpndtFixture;

  const DAY = "2026-06-15";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupPcpndtFixture(db);
  });

  /**
   * F52's sibling — `openFormF` now takes its clock from the caller and bounds `onDate` against it,
   * because `onDate` decides the SERIAL YEAR and a caller that chose it could write into a year
   * whose statutory return had already been filed. So this helper passes both, and a test that
   * walks a year boundary says which day it is standing on rather than depending on the real one.
   */
  const openFor = (studyId: string, onDate = DAY, now = new Date(`${onDate}T06:00:00.000Z`)) =>
    withTx(db, (tx) => openFormF(tx, fx.sonologist, {
      studyId, patientId: fx.patientId, deviceResourceId: fx.deviceResourceId,
      personUserId: fx.sonologist.id, indicationCode: "obstetric", applicability: "pregnant",
      onDate, now,
    }));

  /**
   * TWELVE AT ONCE, on one machine in one year. `Promise.all` rather than `allSettled`: every one of
   * them must SUCCEED — a serial that failed to mint is a scan that could not be registered, which
   * is its own defect.
   */
  it("A1: twelve concurrent openings mint 1..12 — no gap, no duplicate", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => openFor(`STUDY-C${String(i)}`)),
    );

    const serials = results.map((r) => r.serialNo).sort((a, b) => a - b);
    expect(serials).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(serials).size).toBe(12);
    expect(results.every((r) => r.serialYear === 2026)).toBe(true);

    /** And the DATABASE agrees: twelve rows, twelve distinct serials, on one machine and year. */
    const rows = await db.select().from(pcpndtFormF).where(eq(pcpndtFormF.machineId, fx.machineId));
    expect(rows).toHaveLength(12);
    expect([...new Set(rows.map((r) => r.serialNo))].sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    /** The counter's own state is consistent with what it handed out — next is 13, not 12 or 14. */
    const [counter] = await db.select().from(pcpndtFormFSerials)
      .where(eq(pcpndtFormFSerials.machineId, fx.machineId));
    expect([counter!.year, counter!.nextNo]).toEqual([2026, 13]);
  });

  /**
   * ═══ THE UNIQUE INDEX IS THE SECOND LINE, AND WHAT IT ACTUALLY REFUSES IS A DUPLICATE ═══
   *
   * §5 T6 A1 words this as *"the UNIQUE (machine_id, serial_no) refuses a hand-inserted 14"*.
   * **Measured: it does not, and it should not.** After 1..12 exist, a 14 collides with nothing —
   * `pcpndt_form_f_machine_serial_ux` holds NO-DUPLICATE, and GAP-FREENESS comes from the counter
   * above, not from the index. The two properties have two different owners and the plan's sentence
   * merges them (finding F27).
   *
   * So this asserts what the index really holds — a re-used serial is refused — and asserts the gap
   * a hand-inserted 14 would leave is visible to a counting inspector rather than prevented by DDL.
   */
  it("A1: the unique index refuses a REUSED serial; a gap is the counter's business, not the index's (F27)", async () => {
    await openFor("STUDY-U1");

    const dup = db.insert(pcpndtFormF).values({
      id: "01DUPLICATE00000000000001", serialNo: 1, serialYear: 2026,
      machineId: fx.machineId, deviceResourceId: fx.deviceResourceId, personId: fx.personId, studyId: "STUDY-U2",
      patientId: fx.patientId, indicationCode: "i", sections: {}, declaration: {}, referral: {},
      applicability: "pregnant", status: "open",
    });
    await expect(dup).rejects.toThrow(/pcpndt_form_f_machine_serial_ux|duplicate key/);

    /** A 14 is NOT refused — it is a gap, and a gap is what the inspector's count finds. */
    await db.insert(pcpndtFormF).values({
      id: "01GAP00000000000000000001", serialNo: 14, serialYear: 2026,
      machineId: fx.machineId, deviceResourceId: fx.deviceResourceId, personId: fx.personId, studyId: "STUDY-U3",
      patientId: fx.patientId, indicationCode: "i", sections: {}, declaration: {}, referral: {},
      applicability: "pregnant", status: "open",
    });
    const serials = (await db.select().from(pcpndtFormF).where(eq(pcpndtFormF.machineId, fx.machineId)))
      .map((r) => r.serialNo).sort((a, b) => a - b);
    expect(serials).toEqual([1, 14]);
  });

  /** The series is PER MACHINE PER YEAR: a new year restarts at 1, and 31 December stays in its book. */
  it("A1: the counter is per machine per YEAR — 2027 restarts at 1", async () => {
    await openFor("STUDY-Y1", "2026-12-31");
    await openFor("STUDY-Y2", "2026-12-31");
    const next = await openFor("STUDY-Y3", "2027-01-01");
    expect([next.serialNo, next.serialYear]).toEqual([1, 2027]);

    /** F61 — the counter is keyed on the PHYSICAL device now, so a renewal cannot restart the book. */
    const years = await db.select().from(pcpndtFormFSerials)
      .where(eq(pcpndtFormFSerials.deviceResourceId, fx.deviceResourceId));
    expect(years.map((y) => [y.year, y.nextNo]).sort()).toEqual([[2026, 3], [2027, 2]]);
  });
});
