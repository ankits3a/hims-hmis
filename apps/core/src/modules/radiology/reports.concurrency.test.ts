import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { imagingReports } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { amendReport, draftReport, signReport } from "./reports";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T8 — Assertion Book row **A2**'s race half: *"two concurrent amends produce exactly one
 * v2."* Its own file, because a race needs real concurrent transactions.
 *
 * ═══ THE AMEND PATH NEEDS A HELD TRANSACTION AND THE FIRST SIGNATURE DOES NOT — F21, AGAIN ═══
 *
 * **This file's first draft asserted the opposite and was wrong, in the same session that wrote
 * F21.** The reasoning was that `imaging_reports_one_signed_ux` is an INDEX, so — like T4's slot
 * race — every caller must reach it and no interleaving is needed. That is true of the first
 * SIGNATURE and false of an AMEND, and the difference is one line of code: `amendReport` calls
 * `latestSigned` FIRST. That pre-read is exactly the short-circuit F21 is about.
 *
 * What actually happened, measured: three concurrent amends SERIALISED, and each read the previous
 * winner's version as its own starting point. v1→v2→v3 is not a race at all — it is three
 * legitimate sequential amendments, which is correct behaviour and proves nothing about A2.
 *
 * So each transaction is HELD open past its write, which forces both callers to read v1 as the
 * current signed report before either commits. The loser then supersedes a row that is already
 * superseded (a no-op), inserts its own `signed` row, and the INDEX refuses it.
 *
 * **The rule this is the second specimen of: a pre-read in front of the real control is what
 * decides whether a race test needs a hold — not whether the control is an index or a CAS.** T4's
 * slot race has no pre-read and needs none; T5's gate CAS and this amend both do.
 *
 * **The loser's SUPERSEDE goes back with it**, which is the half worth asserting: if v1 had been
 * flipped by a transaction that then failed to insert v2, the study would be left with NO signed
 * report at all — a report that existed at 09:00 and does not exist at 09:01.
 */
describe("two radiologists amending one report (18a T8 A2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const FRESH = new Date(NOW.getTime() - 60_000);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  let seq = 0;
  const signedStudy = async () => {
    seq += 1;
    const study = await acquireStudy(db, fx, {
      idemKey: `c${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
    });
    const { reportId } = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: study.studyId, body: { findings: "Normal study." }, impression: "No abnormality.",
    }));
    const signed = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: study.studyId, reportId, secondFactorAt: FRESH, now: NOW,
    }));
    return { study, signed };
  };

  const HOLD_MS = 200;
  const amend = (studyId: string, impression: string) =>
    withTx(db, async (tx) => {
      const r = await amendReport(tx, fx.radiologist, {
        studyId, secondFactorAt: FRESH, now: NOW, reason: `correction: ${impression}`,
        body: { findings: impression }, impression,
      });
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      return r;
    });

  /** Five rounds, each on its own signed study. No fixture is rebuilt in the loop (§2.144 / F17). */
  it("A2: two concurrent amends produce exactly ONE v2, and v1 stays signed if both cannot", async () => {
    for (let round = 0; round < 5; round += 1) {
      const { study, signed } = await signedStudy();

      const settled = await Promise.allSettled([
        amend(study.studyId, "left renal calculus"),
        amend(study.studyId, "right renal calculus"),
      ]);
      const fulfilled = settled.filter((r) => r.status === "fulfilled");
      const rejected = settled.filter((r) => r.status === "rejected");
      expect([round, fulfilled.length, rejected.length]).toEqual([round, 1, 1]);

      /** EXACTLY ONE signed report on the study — the index is what makes that true. */
      const rows = await db.select().from(imagingReports).where(eq(imagingReports.studyId, study.studyId));
      const signedRows = rows.filter((r) => r.status === "signed");
      expect([round, signedRows.length]).toEqual([round, 1]);

      /** …and it is v2, with v1 superseded rather than gone. */
      expect([round, signedRows[0]!.version]).toEqual([round, signed.version + 1]);
      expect([round, rows.find((r) => r.id === signed.reportId)!.status]).toEqual([round, "superseded"]);

      /** The original text survives, which is what the courtroom reads. */
      expect([round, rows.find((r) => r.id === signed.reportId)!.impression])
        .toEqual([round, "No abnormality."]);
    }
  });

  /**
   * The loser's supersede must roll back WITH its failed insert. A study left with v1 `superseded`
   * and no v2 would be a study whose signed report vanished between two clicks.
   */
  it("A2: the loser's SUPERSEDE rolls back — no study is ever left with zero signed reports", async () => {
    const { study } = await signedStudy();
    await Promise.allSettled([
      amend(study.studyId, "one"), amend(study.studyId, "two"), amend(study.studyId, "three"),
    ]);
    const rows = await db.select().from(imagingReports).where(eq(imagingReports.studyId, study.studyId));
    expect(rows.filter((r) => r.status === "signed")).toHaveLength(1);
    /** Two amends lost, so only ONE supersede survived: three rows in total, not five. */
    expect(rows.filter((r) => r.status === "superseded")).toHaveLength(1);
    expect(rows).toHaveLength(3); // the draft, the signed v2 that lost nothing, and v1
  });

  /** The same index refuses a second SIGNATURE, which is B10 and the reason amend exists at all. */
  it("A2: two concurrent first-signatures on one study — exactly one lands", async () => {
    seq += 1;
    const study = await acquireStudy(db, fx, {
      idemKey: `s${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
    });
    const a = await withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId: study.studyId, body: { f: "a" } }));
    const b = await withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId: study.studyId, body: { f: "b" } }));

    const settled = await Promise.allSettled([
      withTx(db, (tx) => signReport(tx, fx.radiologist, { studyId: study.studyId, reportId: a.reportId, secondFactorAt: FRESH, now: NOW })),
      withTx(db, (tx) => signReport(tx, fx.radiologist, { studyId: study.studyId, reportId: b.reportId, secondFactorAt: FRESH, now: NOW })),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await db.select().from(imagingReports).where(eq(imagingReports.studyId, study.studyId));
    expect(rows.filter((r) => r.status === "signed")).toHaveLength(1);
  });
});
