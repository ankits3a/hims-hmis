import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantLabResultPermissions, runLabOrder, seedLabDeskBase } from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { events, labResults } from "../../kernel/db/schema";
import { nightReleasesAwaitingReview, reviewNightRelease, verifyResult } from "./verify";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * ═══ THE MORNING AFTER — DD11's SECOND PAIR OF HANDS, ARRIVING LATE ═══
 *
 * Night mode is a RELAXATION of separation of duties: between 21:00 and 07:00 IST the solo
 * pathologist on duty may sign the result they keyed, and the row is stamped
 * `pathologist_review_pending = true` so the printed report says PROVISIONAL.
 *
 * **A relaxation with no compensating review is not a relaxation, it is an absent control**, and
 * that is where this build stood. The runbook says so in as many words (`lab-go-live.md` §7):
 *
 *     "Those rows are the morning queue. Somebody must work it, and this build ships no screen
 *      filter for it — read `lab_results` where `pathologist_review_pending` is true."
 *
 * A morning ward round at Apollo, Fortis, Medanta or Yashoda does not begin with a DBA running SQL.
 * NABL 15189 asks who reviewed the results released in the authorised signatory's absence, and the
 * answer has to be a record, not a query somebody remembered to run.
 *
 * ═══ THE SCHEMA ALREADY LEFT THE DOOR OPEN, AND ITS OWN COMMENT SAYS WHY ═══
 *
 * `lab_results_forbid_verified_mutation` (0046) excludes exactly one column from the immutability
 * check — `pathologist_review_pending` — and the paragraph above it explains that the carve-out
 * "is what stops 'the reviewer needs one column' becoming 'the trigger was dropped'". So a verified
 * row is frozen in every field except the one this act clears. **The design anticipated this
 * review; nobody had built it.**
 *
 * That is why this needs no migration and no new table: clearing the flag is the state change the
 * trigger was written to permit, and WHO cleared it belongs in the event stream, which is this
 * project's audit spine.
 */
const DAY = new Date("2026-08-30T06:00:00Z");   // 11:30 IST — the middle of a working day
const NIGHT = new Date("2026-08-30T20:00:00Z"); // 01:30 IST — the solo shift

describe("the morning review of a night-mode release (DD11)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  /** The one-person night lab: `pathologist` AND `lab_technician`, so they may key AND sign. */
  let solo: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    solo = await mkUser(db, "dr.night", ["pathologist", "lab_technician"]);
  });
  afterEach(() => { fx.unregister(); });

  /** A TSH keyed AND signed by one person at 01:30 IST — the only way to mint the flag. */
  async function releasedOvernight(): Promise<{ resultId: string }> {
    const run = await runLabOrder(db, fx, ["TSH"], {
      at: NIGHT, verify: false, enterActor: solo.actor,
    });
    const [row] = await db.select().from(labResults)
      .where(eq(labResults.orderItemId, run.itemIds[0]!));
    await verifyResult(db, solo.actor, fx.decls, { resultId: row!.id }, NIGHT);
    const [after] = await db.select().from(labResults).where(eq(labResults.id, row!.id));
    /** The premise of the whole file, asserted rather than assumed. */
    expect([after!.verificationStatus, after!.pathologistReviewPending]).toEqual(["verified", true]);
    return { resultId: row!.id };
  }

  /* ─────────────────────────────── N1 — the queue exists ─────────────────────────────── */

  /**
   * **THE KILL.** Against the code this guards there is no reader at all: the flag is written, it is
   * carried into three view models and onto the printed page, and **no query anywhere selects on
   * it**. The morning queue was a sentence in a runbook telling a human to open psql.
   */
  it("N1: a night release appears in the morning queue, with what a pathologist needs to judge it", async () => {
    const { resultId } = await releasedOvernight();

    const queue = await nightReleasesAwaitingReview(db, fx.pathologist.actor);
    expect(queue.map((r) => r.resultId)).toEqual([resultId]);

    const [row] = queue;
    /** The patient, the test and the number — a queue that made the reviewer open each row to see
     *  what they were reviewing would be worked by clicking Approve. */
    expect(row!.analyteCode).toBe("TSH");
    expect(row!.patientDisplay.length).toBeGreaterThan(0);
    expect(row!.value.length).toBeGreaterThan(0);
    /** And WHO released it alone, because that is the fact the review is about. */
    expect(row!.releasedBy).toBe(solo.id);
  });

  it("N2: an ordinary daytime signature never enters the queue — it already had two pairs of hands", async () => {
    await runLabOrder(db, fx, ["TSH"], { at: DAY });

    expect(await nightReleasesAwaitingReview(db, fx.pathologist.actor)).toEqual([]);
  });

  /* ────────────────────────── N3/N4 — the review, and who may give it ────────────────────────── */

  it("N3: the review clears the flag, so the next report prints as final rather than PROVISIONAL", async () => {
    const { resultId } = await releasedOvernight();
    const [before] = await db.select().from(labResults).where(eq(labResults.id, resultId));

    await reviewNightRelease(db, fx.pathologist.actor, { resultId }, DAY);

    const [after] = await db.select().from(labResults).where(eq(labResults.id, resultId));
    expect(after!.pathologistReviewPending).toBe(false);
    expect(await nightReleasesAwaitingReview(db, fx.pathologist.actor)).toEqual([]);

    /**
     * ═══ AND NOTHING ELSE ON THE ROW MOVED — THE WHOLE ROW, NOT THREE COLUMNS OF IT ═══
     *
     * The trigger permits exactly one column and refuses any UPDATE that touches a second. This
     * asserts the act did not quietly take the licence for more: **a signed value is corrected with
     * a superseding row, never an edit, and reviewing is not correcting.**
     *
     * Byte-identical-except-one is the strong form. The first draft of this named three columns and
     * a hard-coded `"2.0000"` — which was wrong about the fixture's value, and would have gone on
     * being silent about the other twenty-odd columns even once corrected. Radiology's 0078 review
     * made the same move for the same reason: `expect(after).toEqual(before)` over the whole row.
     */
    expect({ ...after, pathologistReviewPending: true }).toEqual(before);
  });

  /**
   * ═══ THE WHOLE POINT, AND THE ASSERTION THAT CARRIES IT ═══
   *
   * Night mode borrowed the second pair of hands; the morning review is that pair arriving. If the
   * person who released it alone may also review it alone, **nothing has been reviewed** and the
   * flag has been cleared by the same signature that raised it. It is refused as what it is — a
   * separation-of-duties violation — rather than with a new word for the same fact.
   */
  it("N4: the person who released it alone may NOT be the person who reviews it", async () => {
    const { resultId } = await releasedOvernight();

    await expect(reviewNightRelease(db, solo.actor, { resultId }, DAY))
      .rejects.toMatchObject({ code: "sod_violation" });

    const [row] = await db.select().from(labResults).where(eq(labResults.id, resultId));
    expect(row!.pathologistReviewPending).toBe(true);
  });

  it("N5: reviewing a result that was never released under night mode is refused", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: DAY });
    const [row] = await db.select().from(labResults)
      .where(eq(labResults.orderItemId, run.itemIds[0]!));

    await expect(reviewNightRelease(db, fx.pathologist.actor, { resultId: row!.id }, DAY))
      .rejects.toMatchObject({ code: "review_not_pending" });
  });

  it("N6: the review needs the pathologist's grant, and a non-user actor is refused by type", async () => {
    const { resultId } = await releasedOvernight();
    const clerk = await mkUser(db, "lab.clerk2", ["lab_reception"]);

    await expect(reviewNightRelease(db, clerk.actor, { resultId }, DAY))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(reviewNightRelease(db, { type: "system", id: "sweep" }, { resultId }, DAY))
      .rejects.toMatchObject({ code: "user_actor_required" });
  });

  /* ───────────────── N7 — the record NABL asks for, in the audit spine ───────────────── */

  /**
   * The flag is a STATE and it is gone the moment it is cleared. *"Who reviewed the results released
   * in the authorised signatory's absence, and when"* is a question about the past, and a boolean
   * cannot answer it. The event is the record — this project's audit spine — and it names both
   * people, because a review is a relationship between two of them.
   */
  it("N7: the review is EVENTED, naming both the releaser and the reviewer", async () => {
    const { resultId } = await releasedOvernight();
    await reviewNightRelease(db, fx.pathologist.actor, {
      resultId, note: "concur — repeat on the morning run agrees",
    }, DAY);

    const [ev] = await db.select().from(events)
      .where(eq(events.name, "lab.night_release_reviewed"));
    expect(ev).toBeDefined();
    expect(ev!.payload).toMatchObject({
      resultId, reviewedBy: fx.pathologist.id, releasedBy: solo.id,
      note: "concur — repeat on the morning run agrees",
    });
  });

  it("N8: a second review of the same result is refused — the queue cannot be worked twice", async () => {
    const { resultId } = await releasedOvernight();
    await reviewNightRelease(db, fx.pathologist.actor, { resultId }, DAY);

    await expect(reviewNightRelease(db, fx.pathologist.actor, { resultId }, DAY))
      .rejects.toMatchObject({ code: "review_not_pending" });
  });
});
