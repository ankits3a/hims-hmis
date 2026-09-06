import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import {
  events, imagingCriticalFindings, imagingDefinitions, imagingReportDelivery, imagingReports,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { acknowledgeCritical, draftReport, flagCritical, publishReport, signReport } from "./reports";
import { reportView } from "./read";
import { sweepCriticalChaser, sweepUnreadWatchman, UNREAD_REPORT_HOURS } from "./chasers";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a-iii T5 / D7 — **the two chasers.**
 *
 * 18a shipped the critical-communication tier book and made it RECORD-ONLY: the book promised a red
 * finding would reach a clinician within N minutes and nothing ever asked whether it had. These two
 * ask. What this suite is mostly about is that they ask and **do nothing else** — the failure mode
 * of an escalation is not that it fails to fire, it is that it fires sixty times an hour, or that it
 * quietly closes the thing it was supposed to chase.
 */
describe("the chasers (18a-iii T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    /** The governed tier book the chaser reads its windows out of. */
    await db.insert(imagingDefinitions).values({
      id: `def-crit-${String(Date.now())}`, kind: "critical_categories", version: 1, status: "active",
      draftedBy: "t", publishedBy: "t", publishedAt: NOW,
      body: {
        categories: [
          { category: "red", communicate_within_min: 15, requires_read_back: true, examples: [] },
          { category: "orange", communicate_within_min: 120, requires_read_back: false, examples: [] },
        ],
      },
    });
    const registry = new ModuleRegistry();
    registry.install({
      key: "radiology", title: "Rad", menu: [],
      permissions: ["radiology.worklist.read", "radiology.reports.read"], subscriptions: [],
    });
    await syncPermissions(db, registry);
    for (const p of ["radiology.worklist.read", "radiology.reports.read"]) {
      await grantPermissionToRole(db, registry, "radiologist", p);
      await grantPermissionToRole(db, registry, "doctor", p);
      /** The SECOND reader in the first-read test needs the door too — a technologist may read a
       *  signed report, and the fixture's `radiographer` is the only third actor available. */
      await grantPermissionToRole(db, registry, "radiographer", p);
    }
  });
  afterEach(() => { fx.unregister(); });

  /** An acquired study with a SIGNED, PUBLISHED report, and the critical finding flagged on it. */
  const signedStudy = async () => {
    seq += 1;
    const study = await acquireStudy(db, fx, {
      idemKey: `c${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
    });
    const draft = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: study.studyId, body: { findings: "Normal.", technique: "Transabdominal." },
      impression: "No abnormality.",
    }));
    /**
     * `signReport` MINTS A NEW VERSION — v(n+1) signed, with the draft left behind — so the id that
     * matters downstream is the one signing returns, not the one drafting did. The first draft of
     * this fixture returned the DRAFT's id and every Watchman assertion failed on
     * `publishedAt === null`, because `publishReport` stamps the SIGNED row and the fixture was
     * looking at a different one.
     */
    const { reportId } = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: study.studyId, reportId: draft.reportId, secondFactorAt: NOW, now: NOW,
    }));
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, {
      studyId: study.studyId, now: NOW,
    }));
    return { ...study, reportId };
  };

  const flag = (reportId: string, category: "red" | "orange" = "red") =>
    withTx(db, (tx) => flagCritical(tx, fx.radiologist, { reportId, category, now: NOW }));

  const critical = async (criticalId: string) =>
    (await db.select().from(imagingCriticalFindings).where(eq(imagingCriticalFindings.id, criticalId)))[0]!;

  /**
   * ═══ THE SWEEP'S CLOCK COMES FROM THE ROW, NOT FROM THE FIXTURE'S `NOW` ═══
   *
   * `flagCritical` does not stamp `created_at` — the column takes the DATABASE's `defaultNow()`, and
   * `publishReport` likewise writes a real instant. The fixture's `NOW` is a fixed date in August
   * chosen so the study-type book and the service date agree, so a sweep run at `NOW + 20 min`
   * measures a finding created a week LATER and finds nothing overdue.
   *
   * The first draft of this suite did exactly that and read as "the chaser does not chase". It was
   * the fixture's clock disagreeing with the subject's, which is the same shape as every other
   * setup failure in this lane: the sweep was correct and the test was measuring something else.
   *
   * So the window is anchored to what the ROW actually holds, which is also the production shape —
   * a row written by the server clock, swept minutes later by the same clock.
   */
  const minutesAfterFlag = async (criticalId: string, minutes: number) =>
    new Date((await critical(criticalId)).createdAt.getTime() + minutes * 60_000);
  /** The delivery record for a report, or undefined when nobody has read or chased it. */
  const delivery = async (reportId: string) =>
    (await db.select().from(imagingReportDelivery)
      .where(eq(imagingReportDelivery.reportId, reportId)))[0];

  const hoursAfterPublish = async (reportId: string, hours: number) => {
    const [row] = await db.select().from(imagingReports).where(eq(imagingReports.id, reportId));
    return new Date(row!.publishedAt!.getTime() + hours * 3_600_000);
  };
  const emitted = async (name: string) =>
    (await db.select().from(events)).filter((e) => e.name === name);

  /* ════════════════════════ THE CRITICAL CHASER ════════════════════════ */

  it("chases a red finding that is past its tier's window and nobody acknowledged", async () => {
    const study = await signedStudy();
    const { criticalId } = await flag(study.reportId);

    const late = await minutesAfterFlag(criticalId, 20); // window is 15 min
    const result = await sweepCriticalChaser(db, late);

    expect(result.chased).toEqual([{ criticalId, category: "red", overdueMin: 5 }]);
    expect((await emitted("imaging.critical_overdue"))[0]!.payload).toMatchObject({
      criticalId, reportId: study.reportId, studyId: study.studyId, category: "red", overdueMin: 5,
    });
  });

  it("does not chase one still inside its window", async () => {
    const study = await signedStudy();
    const { criticalId } = await flag(study.reportId);
    const early = await minutesAfterFlag(criticalId, 10);
    expect((await sweepCriticalChaser(db, early)).chased).toEqual([]);
    expect(await emitted("imaging.critical_overdue")).toHaveLength(0);
  });

  /**
   * ═══ THE WINDOW IS THE TIER'S OWN, NOT A NUMBER THIS MODULE CHOSE ═══
   *
   * `orange` is two hours in the fixture's book. At twenty minutes a red finding is overdue and an
   * orange one is not — a chaser that used one window for everything passes the test above and
   * fails here, which is the only fixture that can tell the two apart.
   */
  it("reads each tier's own window out of the governed book", async () => {
    const red = await signedStudy();
    const orange = await signedStudy();
    const { criticalId } = await flag(red.reportId, "red");
    await flag(orange.reportId, "orange");

    const late = await minutesAfterFlag(criticalId, 20);
    const chased = (await sweepCriticalChaser(db, late)).chased;
    expect(chased.map((c) => c.category)).toEqual(["red"]);
  });

  /**
   * ═══ THE FAILURE MODE OF AN ESCALATION IS NOT SILENCE, IT IS SIXTY ROWS AN HOUR ═══
   *
   * The chaser runs every minute. Without the mark, one unacknowledged red finding would put an
   * alert in front of a human on every cycle, and an alert surface that does that is one nobody
   * reads. The second sweep must find nothing and emit nothing.
   */
  it("chases each finding ONCE, however many times the sweep runs", async () => {
    const study = await signedStudy();
    const { criticalId } = await flag(study.reportId);
    const late = await minutesAfterFlag(criticalId, 20);

    expect((await sweepCriticalChaser(db, late)).chased).toHaveLength(1);
    expect((await sweepCriticalChaser(db, new Date(late.getTime() + 60_000))).chased).toEqual([]);
    expect((await sweepCriticalChaser(db, new Date(late.getTime() + 120_000))).chased).toEqual([]);
    expect(await emitted("imaging.critical_overdue")).toHaveLength(1);
  });

  /**
   * ═══ D7 — A VOICE, NOT TEETH. THE MARK IS NOT A STATUS ═══
   *
   * The chaser must leave the finding exactly as unacknowledged as it found it. A chaser that
   * "closed" what it escalated would turn an unanswered critical into an answered one at 02:00, on
   * nobody's authority — and `acknowledged_at` is the whole record that a human was told.
   */
  it("changes NOTHING about the finding except recording that it escalated", async () => {
    const study = await signedStudy();
    const { criticalId } = await flag(study.reportId);
    const before = await critical(criticalId);

    await sweepCriticalChaser(db, await minutesAfterFlag(criticalId, 20));
    const after = await critical(criticalId);

    expect([after.acknowledgedAt, after.acknowledgedBy, after.communicatedAt, after.readBackText])
      .toEqual([before.acknowledgedAt, before.acknowledgedBy, before.communicatedAt, before.readBackText]);
    expect(after.category).toBe(before.category);
    expect(after.chasedAt).not.toBeNull();
  });

  it("never chases one a clinician has already acknowledged", async () => {
    const study = await signedStudy();
    const { criticalId } = await flag(study.reportId);
    await withTx(db, (tx) => acknowledgeCritical(tx, fx.radiologist, {
      criticalId, acknowledgedByClinicianId: fx.doctor.id,
      readBack: "left upper lobe mass, will admit", now: NOW,
    }));

    expect((await sweepCriticalChaser(db, await minutesAfterFlag(criticalId, 20))).chased).toEqual([]);
  });

  /**
   * A tier the book does not name is not chased, and that is a decision rather than an omission:
   * the alternative is a default window invented in code, which would make this module quietly set
   * a clinical communication standard the governed book is the only place allowed to set.
   */
  it("does not chase a tier the active book does not name", async () => {
    await db.delete(imagingDefinitions).where(eq(imagingDefinitions.kind, "critical_categories"));
    const study = await signedStudy();
    const { criticalId } = await flag(study.reportId);
    expect((await sweepCriticalChaser(db, new Date(
      (await critical(criticalId)).createdAt.getTime() + 600 * 60_000,
    ))).chased).toEqual([]);
  });

  /* ════════════════════════ THE UNREAD WATCHMAN ════════════════════════ */

  it("chases a signed report nobody has opened after a working day", async () => {
    const study = await signedStudy();
    const result = await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 1));

    expect(result.chased).toHaveLength(1);
    expect(result.chased[0]).toMatchObject({ reportId: study.reportId, studyId: study.studyId });
    expect((await emitted("imaging.report_unread"))[0]!.payload).toMatchObject({
      reportId: study.reportId, studyId: study.studyId,
    });
  });

  it("does not chase one still inside the window", async () => {
    const study = await signedStudy();
    expect((await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS - 1))).chased)
      .toEqual([]);
  });

  /**
   * ═══ THE READ IS WHAT SILENCES IT, AND IT MUST BE SOMEBODY ELSE'S READ ═══
   *
   * `reportView` stamps `first_read_at` for a reader who is not the signer. A doctor opening the
   * report is the thing the Watchman exists to wait for.
   */
  it("stops chasing once a clinician who is not the author opens it", async () => {
    const study = await signedStudy();
    await reportView(db, fx.doctor, study.reportId);

    const row = await delivery(study.reportId);
    expect([row!.firstReadBy, row!.firstReadAt === null]).toEqual([fx.doctor.id, false]);
    expect((await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 1))).chased)
      .toEqual([]);
  });

  /**
   * ═══ THE MUTANT THIS ONE EXISTS FOR ═══
   *
   * A radiologist re-reading their own report is not the referring clinician acting on it. Counting
   * the author's read would make every report look read the moment it was written, and the Watchman
   * would never speak for any report at all — a silence indistinguishable from "everything is fine".
   */
  it("the AUTHOR reading their own report does not count as it having landed", async () => {
    const study = await signedStudy();
    await reportView(db, fx.radiologist, study.reportId);

    /** No delivery row at all is the correct shape for "nobody has read it" — not a row of nulls. */
    expect(await delivery(study.reportId)).toBeUndefined();
    expect((await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 1))).chased)
      .toHaveLength(1);
  });

  it("records the FIRST reader, and a second reader does not overwrite them", async () => {
    const study = await signedStudy();
    await reportView(db, fx.doctor, study.reportId);
    await reportView(db, fx.radiographer, study.reportId);

    expect((await delivery(study.reportId))!.firstReadBy).toBe(fx.doctor.id);
  });

  it("chases each report ONCE, however many times the sweep runs", async () => {
    const study = await signedStudy();
    expect((await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 1))).chased)
      .toHaveLength(1);
    expect((await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 2))).chased)
      .toEqual([]);
    expect(await emitted("imaging.report_unread")).toHaveLength(1);
  });

  /** A voice, not teeth: the report is exactly as published and exactly as unread as it was. */
  /**
   * ═══ THE REPORT ROW IS NOT TOUCHED AT ALL, AND THE DATABASE ENFORCES THAT ═══
   *
   * `imaging_reports_forbid_mutation` (migration 0047) permits only `status` and `published_at` to
   * change after insert — a signed report is a courtroom document. The first design of this feature
   * put `first_read_at` and `unread_chased_at` ON that row and the trigger refused the write, which
   * is how `imaging_report_delivery` came to exist. So this asserts the stronger thing: the report
   * is byte-identical afterwards, and the escalation lives somewhere else entirely.
   */
  it("does not touch the immutable report row at all — the mark lives on the delivery record", async () => {
    const study = await signedStudy();
    const [before] = await db.select().from(imagingReports).where(eq(imagingReports.id, study.reportId));
    await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 1));
    const [after] = await db.select().from(imagingReports).where(eq(imagingReports.id, study.reportId));

    expect(after).toEqual(before);
    const mark = await delivery(study.reportId);
    expect([mark!.unreadChasedAt === null, mark!.firstReadAt]).toEqual([false, null]);
  });

  /** Neither payload may carry a finding, an impression or a name — they are fanned to a browser. */
  it("neither chaser's payload carries anything clinical", async () => {
    const study = await signedStudy();
    const { criticalId } = await flag(study.reportId);
    await sweepCriticalChaser(db, await minutesAfterFlag(criticalId, 20));
    await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 1));

    for (const name of ["imaging.critical_overdue", "imaging.report_unread"]) {
      for (const row of await emitted(name)) {
        const json = JSON.stringify(row.payload);
        expect(json).not.toMatch(/Normal|abnormality|Transabdominal|Asha/i);
      }
    }
  });
});
