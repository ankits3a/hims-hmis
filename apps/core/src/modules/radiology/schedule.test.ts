import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture, startStudyOnMachine } from "../../../test/helpers/radiology";
import { imagingBillDecisions, imagingStudies, orderItems, resources } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { RadiologyError } from "./errors";
import { autoSlotWalkIn, cancelStudy, deviceDiary, markNoShow, rescheduleStudy, scheduleStudy } from "./schedule";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T4 — Assertion Book rows **A2, A3 and A4**. A1 (the slot race) is
 * `schedule.concurrency.test.ts`, because a race needs two connections and this suite runs on one.
 */
describe("imaging scheduling (18a T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  /**
   * ═══ EVERY STUDY GETS ITS OWN INSTANT, BECAUSE T3's DUPLICATE WINDOW IS REAL ═══
   *
   * `placeImagingOrder` refuses the same service for the same patient inside 24 hours (T3 A4) unless
   * the caller passes `duplicateOfItemId` + `duplicateReason`. This suite places the same USG
   * repeatedly, so the first draft of it was refused `duplicate_recent` six times — the guard doing
   * exactly its job against a fixture that had not thought about it.
   *
   * Each placement is therefore 25 hours after the last, which is what a real diary looks like
   * anyway. The alternative — passing the duplicate override everywhere — would have made every
   * study in this suite an `origin: 'duplicate_confirmed'`, which is not the row a scheduling test
   * should be reasoning about.
   */
  let seq = 0;
  const newStudy = (code: string) => {
    seq += 1;
    return placeAndCreateStudy(db, fx, code, `k${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000));
  };

  const schedule = (studyId: string, deviceKey: string, at: Date = SLOT) =>
    withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId, deviceResourceId: fx.devices[deviceKey]!, scheduledAt: at,
    }));

  /* ═══════════════════════════ THE HAPPY PATH ═══════════════════════════ */

  it("books a study onto a device of its own modality and records the slot", async () => {
    const study = await newStudy("USG-ABDO");
    const result = await schedule(study.studyId, "usg");

    expect(result.accessionNo).toBe(study.accessionNo);
    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect([row!.deviceResourceId, row!.scheduledAt?.toISOString()])
      .toEqual([fx.devices.usg, SLOT.toISOString()]);
  });

  /* ═══════════════════════════ A2 — DEVICE STATUS ═══════════════════════════ */

  /**
   * A2's mutant checks only `retired`, and the consequence it names is the Monday-09:00 CT with a
   * failed tube still taking bookings. All four blocking statuses are walked, because a fix that
   * caught `down` and missed `qa_blocked` would leave 18c's whole QA workflow decorative.
   */
  it("A2: `down`, `qa_blocked`, `maintenance` and `retired` all refuse a booking", async () => {
    for (const status of ["down", "qa_blocked", "maintenance", "retired"]) {
      await db.update(resources).set({ status }).where(eq(resources.id, fx.devices.usg!));
      const study = await newStudy("USG-ABDO");
      await expect(schedule(study.studyId, "usg")).rejects.toThrow(RadiologyError);
      await expect(schedule(study.studyId, "usg")).rejects.toThrow(new RegExp(`is ${status} and cannot take bookings`));
    }
  });

  it("A2: `available` and `in_use` BOTH accept — a busy machine is free at 15:00", async () => {
    for (const status of ["available", "in_use"]) {
      await db.update(resources).set({ status }).where(eq(resources.id, fx.devices.usg!));
      const study = await newStudy("USG-ABDO");
      const at = new Date(`2026-08-31T1${status === "available" ? "0" : "5"}:00:00.000Z`);
      const result = await schedule(study.studyId, "usg", at);
      expect(result.scheduledAt).toEqual(at);
    }
  });

  /**
   * ═══ F55 — THE PROPERTY THE FIX ESTABLISHES, WHICH SHIPPED WITH NO TEST THAT COULD SEE IT ═══
   *
   * The second reviewer's sharpest structural point: fourteen scheduling tests and not one booked
   * two OVERLAPPING non-identical instants, while the concurrency suite raced two bookings at the
   * SAME instant — which the pre-existing exact-instant unique index already refused. So the
   * interval SQL, the lock scope and the boundary semantics could all have been deleted and every
   * test would still have passed. These three are the discriminating ones.
   */
  it("F55: a 45-minute study booked 15 minutes into another is REFUSED", async () => {
    const first = await newStudy("MRI-BRAIN");
    await schedule(first.studyId, "mri", new Date("2026-08-31T10:00:00.000Z"));
    const second = await newStudy("MRI-BRAIN");
    await expect(schedule(second.studyId, "mri", new Date("2026-08-31T10:15:00.000Z")))
      .rejects.toMatchObject({ code: "slot_taken" });
  });

  /**
   * ═══ THE REFUSAL NAMES THE MACHINE, NOT ITS ULID ═══
   *
   * Every sentence in this file's refusals used to open `device 01M1VRJ4QVQ…`. A receptionist reads
   * them at a counter and cannot map a ULID to a room, and "which machine" is the only thing they
   * need in order to act. **Ten such sentences were swept and not one test noticed** — the suite
   * asserted `code` and never the prose, which is exactly how the original defect survived. These
   * pin the three a human meets most.
   */
  it("names the machine by code, not by ULID, in the clash / status / modality refusals", async () => {
    const first = await newStudy("MRI-BRAIN");
    await schedule(first.studyId, "mri", new Date("2026-08-31T10:00:00.000Z"));
    const second = await newStudy("MRI-BRAIN");
    await expect(schedule(second.studyId, "mri", new Date("2026-08-31T10:15:00.000Z")))
      .rejects.toMatchObject({ message: expect.stringContaining("DEV-MRI (mri machine)") });
    /** The opaque id must be GONE from the prose, not merely accompanied by the code. */
    await expect(schedule(second.studyId, "mri", new Date("2026-08-31T10:15:00.000Z")))
      .rejects.toMatchObject({ message: expect.not.stringContaining(fx.devices.mri!) });

    const wrong = await newStudy("MRI-BRAIN");
    await expect(schedule(wrong.studyId, "xray", new Date("2026-08-31T14:00:00.000Z")))
      .rejects.toMatchObject({
        code: "modality_mismatch",
        message: expect.stringContaining("DEV-XRAY (xray machine)"),
      });
  });

  /** The boundary is HALF-OPEN: a study starting exactly when another ends is not a clash. */
  it("F55: a study starting exactly when the previous one ends is ACCEPTED", async () => {
    const first = await newStudy("MRI-BRAIN");
    await schedule(first.studyId, "mri", new Date("2026-08-31T10:00:00.000Z"));
    const second = await newStudy("MRI-BRAIN");
    const ok = await schedule(second.studyId, "mri", new Date("2026-08-31T10:45:00.000Z"));
    expect(ok.scheduledAt.toISOString()).toBe("2026-08-31T10:45:00.000Z");
  });

  /**
   * The window is the BOOK's `duration_min` and not a constant: this fixture's types are 20 minutes
   * (`studyTypeRow`'s default), so 10:15 clashes and 10:25 does not. A guard hard-coded to any
   * other number, or to none, fails one of these two.
   */
  it("F55: the refusal window is the study type's own length, not a constant", async () => {
    const first = await newStudy("XR-CHEST");
    await schedule(first.studyId, "xray", new Date("2026-08-31T10:00:00.000Z"));

    const inside = await newStudy("XR-CHEST");
    await expect(schedule(inside.studyId, "xray", new Date("2026-08-31T10:15:00.000Z")))
      .rejects.toMatchObject({ code: "slot_taken" });

    const clear = await newStudy("XR-CHEST");
    const ok = await schedule(clear.studyId, "xray", new Date("2026-08-31T10:25:00.000Z"));
    expect(ok.scheduledAt.toISOString()).toBe("2026-08-31T10:25:00.000Z");
  });

  /* ═══════════════════════════ A3 — MODALITY ═══════════════════════════ */

  it("A3: a study may only be booked on a device of its own modality", async () => {
    const study = await newStudy("MRI-BRAIN");
    await expect(schedule(study.studyId, "usg")).rejects.toThrow(/is a usg machine and this study is mri/);
    /** …and the right machine takes it. */
    const ok = await schedule(study.studyId, "mri");
    expect(ok.deviceResourceId).toBe(fx.devices.mri);
  });

  it("A3: a resource that is not a `device` at all is refused", async () => {
    const study = await newStudy("USG-ABDO");
    await expect(withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: "01NOTADEVICE00000000000001", scheduledAt: SLOT,
    }))).rejects.toThrow(/is not an imaging device/);
  });

  /* ═══════════════════════════ A3 — THE WALK-IN AUTO-SLOT ═══════════════════════════ */

  it("A3: the walk-in auto-slot picks an available device of the right modality and books it NOW", async () => {
    const study = await newStudy("CT-HEAD");
    const result = await withTx(db, (tx) => autoSlotWalkIn(tx, fx.radiographer, {
      studyId: study.studyId, now: NOW,
    }));
    expect(result.deviceResourceId).toBe(fx.devices.ct);
    expect(result.scheduledAt).toEqual(NOW);
  });

  /**
   * The walk-in is NARROWER than the scheduler on purpose: `in_use` is bookable for later and is not
   * a machine to send a patient to at this instant. A test that shared one constant between the two
   * would not have noticed the difference existed.
   */
  it("A3: the walk-in refuses an `in_use` machine even though the SCHEDULER accepts one", async () => {
    await db.update(resources).set({ status: "in_use" }).where(eq(resources.id, fx.devices.ct!));
    const study = await newStudy("CT-HEAD");

    await expect(withTx(db, (tx) => autoSlotWalkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW })))
      .rejects.toThrow(/no available ct machine/);
    /** The same machine, booked for later through the scheduler, is fine. */
    const later = await schedule(study.studyId, "ct", new Date("2026-08-31T15:00:00.000Z"));
    expect(later.deviceResourceId).toBe(fx.devices.ct);
  });

  /* ═══════════════════════════ RESCHEDULE / NO-SHOW ═══════════════════════════ */

  it("a reschedule keeps the study's identity and its ACCESSION, and frees the old slot", async () => {
    const study = await newStudy("USG-ABDO");
    await schedule(study.studyId, "usg");
    const moved = new Date("2026-08-31T11:00:00.000Z");
    const result = await withTx(db, (tx) => rescheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.usg!, scheduledAt: moved,
    }));
    expect(result.accessionNo).toBe(study.accessionNo);

    /** The 09:00 slot is free: a second study can now take it. */
    const other = await newStudy("USG-ABDO");
    const second = await schedule(other.studyId, "usg", new Date("2026-08-31T09:00:00.000Z"));
    expect(second.scheduledAt.toISOString()).toBe("2026-08-31T09:00:00.000Z");
  });

  it("a no-show frees the machine's diary, which is the point of recording it", async () => {
    const study = await newStudy("USG-ABDO");
    await schedule(study.studyId, "usg");
    await withTx(db, (tx) => markNoShow(tx, fx.radiographer, study.studyId));

    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect(row!.status).toBe("no_show");

    const other = await newStudy("USG-ABDO");
    const retake = await schedule(other.studyId, "usg");
    expect(retake.scheduledAt).toEqual(SLOT);

    /** …and the no-show study is off the diary. */
    const diary = await deviceDiary(db, fx.radiographer, fx.devices.usg!);
    expect(diary.map((d) => d.studyId)).toEqual([other.studyId]);
  });

  /* ═══════════════════════════ A4 — CANCEL, THE THREE BANDS ═══════════════════════════ */

  it("A4: cancelling from `scheduled` needs no reason and raises no bill decision", async () => {
    const study = await newStudy("USG-ABDO");
    await schedule(study.studyId, "usg");
    const result = await withTx(db, (tx) => cancelStudy(tx, fx.doctor, fx.decls, { studyId: study.studyId }));

    expect(result.billDecisionId).toBeNull();
    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect(row!.status).toBe("cancelled");
    /** The ORDER ITEM went with it — a module that flipped only its own column leaves a live charge. */
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, study.itemId));
    expect(item!.status).toBe("cancelled");
  });

  it("A4: cancelling from `in_acquisition` REQUIRES a reason", async () => {
    const study = await newStudy("USG-ABDO");
    await db.update(imagingStudies).set({ status: "in_acquisition" }).where(eq(imagingStudies.id, study.studyId));
    await expect(withTx(db, (tx) => cancelStudy(tx, fx.doctor, fx.decls, { studyId: study.studyId })))
      .rejects.toThrow(/needs a reason/);
  });

  /**
   * B6 — the bill decision turns on `acquired_at`, NOT on the status band. A patient on the table
   * with nothing exposed yet is a cancel with no money in it; the moment an acquisition instant
   * exists, film and time were spent and somebody must decide who pays.
   */
  /**
   * ═══ F53 — B6's DISTINCTION HAD NO COLUMN TO READ, AND THIS TEST IS WHERE THAT SHOWS ═══
   *
   * B6 wanted two cases: *"a study can be `in_acquisition` with the patient on the table and
   * nothing exposed yet; that is a cancel with no money in it"*, against one where film and time
   * were spent. The old fixture built the first by hand-setting `status:'in_acquisition'` and
   * leaving `acquired_at` null — but `startAcquisition` ALWAYS stamps `acquisition_started_at`, so
   * **there is no reachable `in_acquisition` state without one**, and there is no column anywhere
   * that records whether an exposure was made. The distinction was unimplementable, which is why
   * the guard that tried to read it could never fire.
   *
   * So the rule is now the one the design can actually support, and it is the honest one: **the
   * patient going on the machine raises the decision, and a HUMAN decides whether to charge.** That
   * is what a bill-decision QUEUE is for — it is not a charge, it is a question put to the counter.
   * A study cancelled BEFORE the machine (scheduled, checked-in, ready) still raises nothing.
   */
  it("A4: a cancel BEFORE the machine raises no bill decision (F53)", async () => {
    const study = await newStudy("USG-ABDO");
    await schedule(study.studyId, "usg");
    const result = await withTx(db, (tx) => cancelStudy(tx, fx.doctor, fx.decls, {
      studyId: study.studyId, reason: "patient could not attend",
    }));
    expect(result.billDecisionId).toBeNull();
    expect(await db.select().from(imagingBillDecisions)).toHaveLength(0);
  });

  /**
   * ═══ F53 (CLOSE REVIEW) — THIS FIXTURE BUILT A STATE THE SYSTEM CANNOT PRODUCE ═══
   *
   * The old version set `status:'in_acquisition'` AND `acquiredAt: NOW` by hand, and its own
   * comment recorded that the CHECK constraint refused the first attempt — the database saying, in
   * as many words, that this is not a state the system reaches. The fixture was widened instead of
   * the premise being questioned. `acquired_at` has exactly ONE writer, and that UPDATE sets
   * `status:'acquired'` in the same `SET`, so `in_acquisition` with an acquisition instant is
   * unreachable and the guard reading it could never fire for any input: the fourth of DD12b's four
   * money facts was dead, while a study that DID reach `acquired` was refused a cancel and pointed
   * at a bill decision no code could create. Both doors shut.
   *
   * `acquisition_started_at` is the operand B6 was describing — "the patient went on the machine" —
   * and it is always non-NULL for `in_acquisition`. The fixture now uses `startAcquisition`, so the
   * state under test is one the product actually produces.
   */
  it("A4: a study cancelled ON THE MACHINE raises `performed_then_cancelled` (F53)", async () => {
    seq += 1;
    const study = await startStudyOnMachine(db, fx, {
      idemKey: `m${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
    });

    /**
     * The cancel is the RADIOLOGIST's or the radiographer's: `in_acquisition → cancelled` names
     * those two and not `doctor`. The old fixture could use the doctor only because it never
     * advanced the workflow instance — the row said `in_acquisition` and the machine did not.
     */
    const result = await withTx(db, (tx) => cancelStudy(tx, fx.radiologist, fx.decls, {
      studyId: study.studyId, reason: "images unusable, patient left",
    }));
    expect(result.billDecisionId).not.toBeNull();

    const decisions = await db.select().from(imagingBillDecisions);
    expect(decisions).toHaveLength(1);
    expect([decisions[0]!.kind, decisions[0]!.studyId]).toEqual(["performed_then_cancelled", study.studyId]);
  });

  /**
   * A4's own mutant: allowing a cancel after acquisition. The consequence it names is images that
   * exist against an order marked `cancelled` with no bill decision anywhere — a study no
   * reconciliation can see, which is I1's leak.
   */
  it("A4 mutant: `acquired`, `reported` and `published` all REFUSE a cancel", async () => {
    for (const status of ["acquired", "reported", "published"]) {
      const study = await newStudy("USG-ABDO");
      await db.update(imagingStudies).set({ status }).where(eq(imagingStudies.id, study.studyId));
      await expect(withTx(db, (tx) => cancelStudy(tx, fx.doctor, fx.decls, {
        studyId: study.studyId, reason: "too late",
      }))).rejects.toThrow(/images exist, so this is a bill decision and not a cancel/);

      /** And nothing moved: the item is still live and no decision was raised. */
      const [item] = await db.select().from(orderItems).where(eq(orderItems.id, study.itemId));
      expect(item!.status).not.toBe("cancelled");
    }
    expect(await db.select().from(imagingBillDecisions)).toHaveLength(0);
  });
});
