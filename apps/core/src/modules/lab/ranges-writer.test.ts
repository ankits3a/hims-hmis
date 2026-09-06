import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantLabResultPermissions, runLabOrder, seedLabDeskBase,
} from "../../../test/helpers/lab";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { labAnalytes, labReferenceRanges, labResults } from "../../kernel/db/schema";
import { putReferenceRange, rangesFor } from "./catalogue";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * ═══ THE RANGE BOOK HAD A READER, A CENSUS ROW, AND NO DOOR ═══
 *
 * `lab_reference_ranges` had exactly two writes in the whole tree, both in
 * `scripts/seed-lab-catalogue.ts` — a `delete` of every row followed by an `insert` — and that script
 * refuses to run against production by design. Meanwhile `GET /lab/catalogue/analytes/:id/ranges`
 * reads the table, `resolveRange` snapshots its answer onto every result, and `standup:check`'s
 * `lab_range_sources_present` requires it.
 *
 * **So a hospital that loaded its own catalogue through the shipped routes got analytes and
 * orderables and no reference bands**: every flag inert, and a printed report with no biological
 * reference interval — which is not a report an NABL laboratory may issue.
 *
 * ═══ AND TWO LATENT DEFECTS GO LIVE THE MOMENT THE DOOR OPENS ═══
 *
 * Both are invisible today only because the sole writer is a curated fixture (measured: 124 rows,
 * zero overlaps, every `effectiveFrom` the same past date).
 *
 *  1. **`pickBySex` is `rows.find(...)` over `rangesFor`, which had no `ORDER BY`.** Two bands
 *     overlapping for one (sex, age window) would decide a report's flag by the order Postgres
 *     happened to return rows in. This is the shape that had already bitten the analyser ingest in
 *     this same phase, one table over.
 *  2. **`effective_from` is `notNull()` and has ZERO readers.** Nothing in `ranges.ts` or
 *     `catalogue.ts` mentions it, so a band dated next year would take effect the moment it is
 *     written.
 *
 * A door that admitted either would be a door that manufactures the defect it exists to enable. So
 * the guard ships with the door rather than after it.
 */
const AT = new Date("2026-08-30T06:00:00Z");
const EFFECTIVE = "2026-01-01";

describe("the reference range book has a door, and the door refuses what the code cannot honour", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let curator: { id: string; actor: Actor };
  let outsider: { id: string; actor: Actor };
  let tshId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    curator = fx.pathologist;
    /**
     * A role the fixture grants NOTHING. `seedLabDeskBase` hands `lab.catalogue.manage` to
     * `lab_reception` among others, so a "clerk" built from a shipped lab role would already hold
     * the grant and R7 would assert a refusal that could not happen.
     */
    await ensureRole(db, "lab_courier");
    outsider = await mkUser(db, "lab.courier", ["lab_courier"]);
    const [tsh] = await db.select({ id: labAnalytes.id }).from(labAnalytes)
      .where(eq(labAnalytes.code, "TSH"));
    tshId = tsh!.id;
    /** The fixture seeds a curated book; these tests are about what a CURATOR may add to it. */
    await db.delete(labReferenceRanges).where(eq(labReferenceRanges.analyteId, tshId));
  });
  afterEach(() => { fx.unregister(); });

  const band = (over: Partial<Parameters<typeof putReferenceRange>[2]> = {}) => ({
    analyteId: tshId,
    sex: "any" as const,
    ageMinDays: 6570,
    ageMaxDays: 36500,
    low: "0.3500",
    high: "4.9400",
    text: null,
    criticalLow: null,
    criticalHigh: null,
    source: "Tietz 7e, kit insert lot 22B",
    effectiveFrom: EFFECTIVE,
    ...over,
  });

  /* ───────────────────────────── R1 — the door exists at all ───────────────────────────── */

  it("R1: a curator writes a band and the reader returns it, with the SOURCE NABL asks for", async () => {
    await putReferenceRange(db, curator.actor, band(), AT);

    const rows = await rangesFor(db, tshId);
    expect(rows).toHaveLength(1);
    expect([rows[0]!.low, rows[0]!.high, rows[0]!.source])
      .toEqual(["0.3500", "4.9400", "Tietz 7e, kit insert lot 22B"]);
  });

  /* ───────────── R2/R3 — the overlap refusal, and the overlap that is NOT one ───────────── */

  /**
   * **THE KILL FOR DEFECT 1.** Without this the second band is simply stored, and which of the two a
   * patient's report is flagged against depends on row order.
   */
  it("R2: a second band overlapping the first for the SAME sex is refused, not stored", async () => {
    await putReferenceRange(db, curator.actor, band(), AT);

    await expect(putReferenceRange(db, curator.actor, band({
      ageMinDays: 18250, ageMaxDays: 36500, low: "0.4000", high: "5.5000",
    }), AT)).rejects.toMatchObject({ code: "range_overlap" });

    expect(await rangesFor(db, tshId)).toHaveLength(1);
  });

  /**
   * ═══ THE HALF THAT MUST NOT BREAK — `any` AND A NAMED SEX ARE NOT AN OVERLAP ═══
   *
   * `pickBySex` prefers an exact sex and falls back to `any`, so a book that carries a general adult
   * band and a narrower one for women is the DESIGN and not a mistake. A refusal that compared age
   * windows without comparing the sex value would make the range book unable to express the most
   * ordinary thing in it — and the author would then discover the rule by having their real book
   * rejected.
   */
  it("R3: an `any` band and a `female` band over the same ages are both accepted", async () => {
    await putReferenceRange(db, curator.actor, band(), AT);
    await putReferenceRange(db, curator.actor, band({ sex: "female", low: "0.4000", high: "4.1000" }), AT);

    expect(await rangesFor(db, tshId)).toHaveLength(2);
  });

  it("R4: two bands that merely TOUCH are not an overlap — the high bound is exclusive", async () => {
    await putReferenceRange(db, curator.actor, band({ ageMinDays: 0, ageMaxDays: 6570 }), AT);
    await putReferenceRange(db, curator.actor, band({ ageMinDays: 6570, ageMaxDays: 36500 }), AT);

    expect(await rangesFor(db, tshId)).toHaveLength(2);
  });

  /* ───────────────────────────── R5 — a future band is refused ───────────────────────────── */

  /**
   * **THE KILL FOR DEFECT 2.** `effective_from` is `notNull()` and NOTHING reads it, so a band dated
   * next year takes effect the instant it is written. The honest door refuses what the code cannot
   * honour, and says so — rather than accepting a date it will silently ignore.
   *
   * Giving the column a reader is a different and larger decision (it is range-book VERSIONING, and
   * it changes how every historical result resolves), so it is reported rather than smuggled in
   * here. Until then this refusal is the truthful one.
   */
  it("R5: a band effective in the FUTURE is refused, because nothing reads the date", async () => {
    await expect(putReferenceRange(db, curator.actor, band({ effectiveFrom: "2027-01-01" }), AT))
      .rejects.toMatchObject({ code: "catalogue_invalid" });

    expect(await rangesFor(db, tshId)).toHaveLength(0);
  });

  /* ──────────────────────────── R6/R7 — shape, and who may write ──────────────────────────── */

  it("R6: an inverted age band and a band with no value at all are both refused at the door", async () => {
    await expect(putReferenceRange(db, curator.actor, band({ ageMinDays: 36500, ageMaxDays: 0 }), AT))
      .rejects.toMatchObject({ code: "catalogue_invalid" });
    await expect(putReferenceRange(db, curator.actor, band({ low: null, high: null, text: null }), AT))
      .rejects.toMatchObject({ code: "catalogue_invalid" });

    /**
     * Both are ALSO refused by `lab_reference_ranges_age_ck` and `..._value_ck`. The table is the
     * backstop for everything that never passes through this function; the sentence here is for the
     * curator at a screen, which is `upsertAnalyte`'s own argument for doing the same thing twice.
     */
    expect(await rangesFor(db, tshId)).toHaveLength(0);
  });

  it("R7: writing the range book needs `lab.catalogue.manage`, and a non-user actor is refused by TYPE", async () => {
    await expect(putReferenceRange(db, outsider.actor, band(), AT))
      .rejects.toMatchObject({ code: "permission_denied" });

    /**
     * ═══ `permission_denied` AND NOT `user_actor_required`, AND THAT IS A FINDING, NOT A CHOICE ═══
     *
     * `assertMayManage` refuses a non-user actor by TYPE — correctly, and before it reaches
     * `hasPermission`, whose `false` would alias "may not" with "is not a user". But it reports the
     * refusal as `permission_denied`, which is the aliasing its own comment argues against, while
     * `results.ts`'s `assertMay` has carried `user_actor_required` for exactly this since 17b.
     *
     * Two doors, two vocabularies for one fact. **Pinned as it behaves rather than as it ought to**:
     * changing a refusal code on a door three routes already use is a behaviour change to shared
     * surface and does not belong inside a PR that adds a writer. Reported instead.
     */
    await expect(putReferenceRange(db, { type: "system", id: "sweep" }, band(), AT))
      .rejects.toMatchObject({ code: "permission_denied" });

    /** And a grant makes it work — otherwise this asserts only that the fixture is under-permissioned. */
    await grantPermissionToRole(db, fx.registry, "lab_courier", "lab.catalogue.manage");
    await putReferenceRange(db, outsider.actor, band(), AT);
    expect(await rangesFor(db, tshId)).toHaveLength(1);
  });

  /* ─────────────── R8 — the end of the LIFECYCLE, not the end of what changed ─────────────── */

  /**
   * ═══ #136 — A NEW DOOR IS WALKED TO THE END OF THE LIFECYCLE ═══
   *
   * A band that stores correctly and never reaches a report is a door onto a cupboard. The value of
   * this whole PR is that a curator's number becomes the interval a patient's report is flagged
   * against, so the assertion follows it all the way to the result row that `reports.ts` prints —
   * through `resolveRange`, which snapshots it at entry precisely so a later edit cannot re-flag a
   * signed value.
   */
  it("R8: a band written through the door is the interval the RESULT snapshots and the report prints", async () => {
    await putReferenceRange(db, curator.actor, band({
      ageMinDays: 0, ageMaxDays: 36500, low: "1.0000", high: "2.0000",
    }), AT);

    const run = await runLabOrder(db, fx, ["TSH"], { at: AT, values: { TSH: "9.9" } });
    const [row] = await db.select().from(labResults)
      .where(eq(labResults.orderItemId, run.itemIds[0]!));

    expect([row!.refLow, row!.refHigh]).toEqual(["1.0000", "2.0000"]);
    /** And the flag follows the band the curator wrote, rather than the one the fixture shipped. */
    expect(row!.flag).toBe("H");
  });

  /* ───────────────── R9 — the reader is ORDERED, so two reads always agree ───────────────── */

  /**
   * The overlap refusal above closes the door on new ambiguity; this closes it on any that already
   * exists. `rangesFor` had no `ORDER BY`, and `pickBySex` takes the FIRST match — so on a book
   * loaded before this door existed, the same patient could be flagged against different intervals
   * on two reads of identical data. An unordered query is a decision nobody made.
   */
  it("R9: the reader returns bands in a specified order, so `pickBySex` cannot pick differently twice", async () => {
    await putReferenceRange(db, curator.actor, band({ ageMinDays: 6570, ageMaxDays: 36500 }), AT);
    await putReferenceRange(db, curator.actor, band({ ageMinDays: 0, ageMaxDays: 6570 }), AT);
    await putReferenceRange(db, curator.actor, band({ sex: "female", ageMinDays: 0, ageMaxDays: 6570 }), AT);

    const once = await rangesFor(db, tshId);
    const twice = await rangesFor(db, tshId);
    expect(once.map((r) => r.id)).toEqual(twice.map((r) => r.id));
    /** Narrowest-starting band first, and sex breaking the tie — a stated order, not an emergent one. */
    expect(once.map((r) => [r.ageMinDays, r.sex]))
      .toEqual([[0, "any"], [0, "female"], [6570, "any"]]);
  });
});
