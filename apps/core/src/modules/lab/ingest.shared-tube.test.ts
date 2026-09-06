import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  deskAndLabel, grantLabResultPermissions, seedLabDeskBase, serviceIdForLabCode,
} from "../../../test/helpers/lab";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  labAnalytes, labOrderableAnalytes, labResults, labSpecimenItems, labSpecimens, orderItems,
} from "../../kernel/db/schema";
import { receive } from "./accession";
import { ingestResults, LAB_RESULTS_INTERFACE } from "./ingest";
import { LAB_INSTRUMENTS_READ, mapInstrumentCode, registerInstrument } from "./instruments";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * ═══ 17-E — THE SHARED TUBE, WHICH IS THE ORDINARY CASE AND NOT AN EDGE CASE ═══
 *
 * `specimens.ts` draws ONE tube per `(specimen_type, container)` across the whole order group, so an
 * outpatient billed for LFT and RFT together gives **one** serum SST tube carrying **two** order
 * items. That is not a corner: it is what an Indian OPD morning looks like, and it is the reason the
 * tube is drawn once instead of twice.
 *
 * ═══ WHAT WAS WRONG, STATED PRECISELY: THE LOOP NEVER ITERATED ═══
 *
 * `attachMachineValue` looked like it tried each open item on the tube in turn. It did not. Every
 * path through the body left the function — `return { resultId }` on success, `return { park }` on a
 * `LabError`, `throw` otherwise — so **iteration two was unreachable, and the trailing
 * `return { park: "no_open_item" }` after the loop was dead code.** Only `items[0]` was ever tried,
 * out of a query with **no analyte filter and no `ORDER BY`**: an arbitrary row from an unordered
 * set, wearing the shape of an iteration.
 *
 * A reader of that code sees a loop and assumes a fallback exists. There was none. So a transaminase
 * arriving from the chemistry analyser attached or parked according to which of two rows Postgres
 * returned first — same block, same tube, same patient, two outcomes, and nothing anywhere recording
 * that a choice had been made at all.
 *
 * ═══ THE FIX NARROWS; IT DOES NOT SEARCH HARDER (D4) ═══
 *
 * The candidates are filtered to the items whose orderable actually REPORTS the analyte, through
 * `lab_orderable_analytes` — the catalogue already answers *"which of these tests reports a
 * transaminase"* and nothing had asked it. Then the loop is made to iterate. D4 is untouched: a value
 * no open item reports still parks, and parking is a state and not an error.
 */
describe("17-E — a machine value on a SHARED tube finds its own order item", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let instrumentId: string;
  let bridge: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    await grantPermissionToRole(db, fx.registry, "pathologist", "lab.instruments.manage");
    await ensureRole(db, "lab_bridge");
    await grantPermissionToRole(db, fx.registry, "lab_bridge", LAB_INSTRUMENTS_READ);
    await grantPermissionToRole(db, fx.registry, "lab_bridge", LAB_RESULTS_INTERFACE);
    bridge = await mkUser(db, "lab.bridge", ["lab_bridge"]);
    ({ instrumentId } = await registerInstrument(db, fx.pathologist.actor, {
      code: "ANL-CHEM-1", name: "Chemistry analyser", sampleIdMode: "barcode",
    }));
  });
  afterEach(() => { fx.unregister(); });

  async function analyteIdFor(code: string): Promise<string> {
    const [row] = await db.select({ id: labAnalytes.id }).from(labAnalytes)
      .where(eq(labAnalytes.code, code));
    return row!.id;
  }

  async function mapCode(instrumentCode: string, analyteCode: string): Promise<string> {
    const analyteId = await analyteIdFor(analyteCode);
    await mapInstrumentCode(db, fx.pathologist.actor, { instrumentId, instrumentCode, analyteId });
    return analyteId;
  }

  /**
   * ═══ THE ORDER OF `codes` IS THE INSTRUMENT, AND IT IS NOT AN ACCIDENT ═══
   *
   * `deskOrder` inserts the items in the order it is given, and the unfixed lookup has no `ORDER BY`
   * — so on a table this size Postgres returns them in insertion order and `items[0]` is the FIRST
   * code listed. Passing `["RFT", "LFT"]` therefore puts the item that does NOT report a transaminase
   * in front, which is what makes the defect reproduce on every run rather than on half of them. A
   * test that relied on luck here would have gone green often enough to be believed.
   */
  async function sharedSerumTube(
    codes: readonly string[] = ["RFT", "LFT"],
  ): Promise<{ specimenNo: string }> {
    const { specimens } = await deskAndLabel(db, fx, codes);
    /** ONE tube for both, which is the premise of the whole file — asserted, never assumed. */
    expect(specimens).toHaveLength(1);
    const specimenNo = specimens[0]!.specimenNo;
    await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo }));
    const [tube] = await db.select().from(labSpecimens)
      .where(eq(labSpecimens.specimenNo, specimenNo));
    const items = await db.select().from(labSpecimenItems)
      .where(eq(labSpecimenItems.specimenId, tube!.id));
    expect(items).toHaveLength(2);
    return { specimenNo };
  }

  async function transmit(specimenNo: string, code: string, value: string) {
    return await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: `run-${code}-${value}`,
      rows: [{ position: 1, sampleId: specimenNo, code, value }],
    });
  }

  /**
   * **THE KILL.** Against the deployed code the AST parks, because the only item ever tried is the
   * RFT — which does not report a transaminase — and the LFT sitting on the very same tube is never
   * reached.
   */
  it("A1: a transaminase attaches to the LFT item even when the RFT item is looked up first", async () => {
    await mapCode("AST", "SGOT");
    const { specimenNo } = await sharedSerumTube(["RFT", "LFT"]);

    const out = await transmit(specimenNo, "AST", "42");

    expect({ attached: out.attached.length, parked: out.parked })
      .toEqual({ attached: 1, parked: [] });
    expect(await db.select().from(labResults)).toHaveLength(1);
  });

  /** The mirror, so the assertion is about the ANALYTE and not about the order of two words. */
  it("A2: and it attaches when the LFT item comes first — the outcome does not depend on row order", async () => {
    await mapCode("AST", "SGOT");
    const { specimenNo } = await sharedSerumTube(["LFT", "RFT"]);

    const out = await transmit(specimenNo, "AST", "42");

    expect({ attached: out.attached.length, parked: out.parked })
      .toEqual({ attached: 1, parked: [] });
  });

  it("A3: the value lands on the order item whose orderable REPORTS it, not merely on the tube", async () => {
    const sgot = await mapCode("AST", "SGOT");
    const { specimenNo } = await sharedSerumTube(["RFT", "LFT"]);
    await transmit(specimenNo, "AST", "42");

    const [row] = await db.select().from(labResults);
    const [item] = await db.select({ serviceId: orderItems.serviceId }).from(orderItems)
      .where(eq(orderItems.id, row!.orderItemId));
    expect([item!.serviceId, row!.analyteId]).toEqual([serviceIdForLabCode("LFT"), sgot]);
  });

  /**
   * ═══ THE HALF THAT MUST NOT BREAK: D4 IS UNCHANGED ═══
   *
   * *"NEVER ATTACH BY GUESS. A result that cannot be named is PARKED, and parking is a state, not an
   * error."* Narrowing the candidates must not become licence to search until something accepts. A
   * value no open item on this tube reports still parks — as `no_open_item`, which is the true
   * sentence: nothing on this tube ordered a glucose.
   */
  it("A4: a value no open item on the tube reports still PARKS — the fix narrows, it does not guess", async () => {
    await mapCode("GLU", "GLUF");
    const { specimenNo } = await sharedSerumTube();

    const out = await transmit(specimenNo, "GLU", "95");

    expect(out.attached).toHaveLength(0);
    /**
     * **THE DETAIL IS PART OF THE ASSERTION.** `no_open_item` is true of two different situations —
     * nothing is open on this tube at all, and things are open but none of them is a glucose — and
     * the INBOX shows the underlying code to the person deciding what to do next. Asserting only the
     * reason would let the two collapse, which is precisely what the analyte filter nearly did:
     * `inbox.test.ts`'s applicability MUTANT caught it, and it caught it because it named its
     * refusal instead of accepting any `LabError`.
     */
    expect(out.parked.map((p) => [p.reason, p.detail]))
      .toEqual([["no_open_item", "unknown_analyte"]]);
    expect(await db.select().from(labResults)).toHaveLength(0);
  });

  /**
   * ═══ THE TWO PARK REASONS MEAN DIFFERENT THINGS TO THE HUMAN AT THE INBOX ═══
   *
   * *"This machine sent a number for a test nobody ordered"* against *"a control refused this number
   * and it needs a second pair of hands"*. A fix that collapsed them would make the inbox unreadable
   * — and `guard_refused` is what 17d's applicability control and the absurd envelope produce, both
   * of which need a second person a machine does not have.
   */
  it("A5: a guard refusal on the item that DOES report the analyte parks as `guard_refused`", async () => {
    /**
     * SODIUM, not a transaminase — because SGOT carries no absurd envelope in this catalogue and a
     * test that reached for one would have proved nothing. `NA` is `absurd 90..200`, and it is
     * reported by the RFT: the item that is looked up SECOND here, so the assertion only holds if
     * the loop reaches it.
     */
    await mapCode("NA+", "NA");
    const { specimenNo } = await sharedSerumTube(["LFT", "RFT"]);

    const out = await transmit(specimenNo, "NA+", "999");

    expect(out.attached).toHaveLength(0);
    /**
     * **THE DETAIL IS THE ASSERTION, NOT THE REASON.** Against the unfixed code this parks as
     * `guard_refused` too — but with detail `unknown_analyte`, because the only item ever tried was
     * the LFT and the refusal was "a liver panel does not report a sodium". Same code, an entirely
     * different fact, and asserting the reason alone would have passed on the defect (#140).
     */
    expect(out.parked.map((p) => [p.reason, p.detail]))
      .toEqual([["guard_refused", "absurd_value"]]);
    expect(await db.select().from(labResults)).toHaveLength(0);
  });

  it("A6: two items reporting ONE analyte — the value lands on one of them, deterministically", async () => {
    const tsh = await mapCode("TSH", "TSH");
    /**
     * The standalone TSH and the thyroid profile both report TSH and both draw serum into an SST, so
     * this is ONE tube whose two open items each legitimately want the same measurement. In the real
     * catalogue the same shape is a health package beside a standalone test — the ordinary
     * corporate-hospital order, and the reason this is not a curiosity.
     */
    const owners = await db.select({ serviceId: labOrderableAnalytes.serviceId })
      .from(labOrderableAnalytes).where(eq(labOrderableAnalytes.analyteId, tsh));
    expect(owners.length).toBeGreaterThan(1);

    const { specimenNo } = await sharedSerumTube(["TSH", "TFT"]);
    const out = await transmit(specimenNo, "TSH", "2.4");

    /**
     * ONE row, on one of the two items that asked for it. Before the analyte filter this was a
     * SILENT WRONG ATTACHMENT — the value went to `items[0]`, which on another tube is a test that
     * does not report the analyte at all. It is now an attachment to a RIGHT item, and what remains
     * is that the sibling stays outstanding, which the bench worklist shows.
     */
    expect(out.attached).toHaveLength(1);
    const rows = await db.select().from(labResults).where(eq(labResults.analyteId, tsh));
    expect(rows).toHaveLength(1);

    /**
     * ═══ AND THE SIBLING IS OUTSTANDING, NOT SILENTLY COMPLETE ═══
     *
     * This is the assertion that stops the incompleteness being mistaken for a fix. A health package
     * and a standalone LFT on one visit is the ordinary corporate-hospital order, and the package's
     * transaminase line is still owed a number.
     *
     * It is NOT resolved here, and the reason is structural: `matchParkedResult` names a **tube**
     * (`{ parkedResultId, specimenNo }`) and not an order item, so parking the ambiguity would send
     * the human to an inbox whose only move is to re-run the same ambiguous attachment. A dead end is
     * worse than a visible incompleteness. Recorded in §6 for the phase that gives the inbox a
     * per-ITEM match — reported, not inferred away.
     */
    const itemsWithTsh = new Set(rows.map((r) => r.orderItemId));
    const allItems = await db.select({ id: orderItems.id, serviceId: orderItems.serviceId })
      .from(orderItems)
      .where(eq(orderItems.status, "in_progress"));
    const unresulted = allItems.filter((i) => !itemsWithTsh.has(i.id));
    expect(unresulted.length).toBeGreaterThan(0);
  });
});
