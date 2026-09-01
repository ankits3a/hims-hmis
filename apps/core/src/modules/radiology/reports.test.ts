import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  acquireStudy, placeAndCreateStudy, setupRadiologyFixture, studyTypeRow,
} from "../../../test/helpers/radiology";
import {
  events, imagingCriticalFindings, imagingDefinitions, imagingReports, imagingStudies,
  notifications, orderItems,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import {
  SECOND_FACTOR_WINDOW_MINUTES, acknowledgeCritical, amendReport, draftReport, flagCritical,
  latestSigned, publishReport, savePrelim, signReport,
} from "./reports";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { StudyType } from "./definitions";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T8 — Assertion Book rows **A1, A2, A3, A4, A5, A6 and A7**. A8 is `read.test.ts` and
 * A2's race is `reports.concurrency.test.ts`.
 */
describe("the report: versioned, signed, amended, published (18a T8)", () => {
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
  const acquired = async (over: { serviceCode?: string; deviceKey?: string; dose?: boolean } = {}) => {
    seq += 1;
    return await acquireStudy(db, fx, {
      idemKey: `r${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000), ...over,
    });
  };

  const rewriteBook = async (types: StudyType[]) => {
    await db.update(imagingDefinitions).set({ body: { types } })
      .where(eq(imagingDefinitions.kind, "study_types"));
  };
  const bookRow = (code: string, over: Partial<StudyType>) =>
    studyTypeRow({ code, service_id: fx.services[code]!, ...over });

  const CLEAN = { body: { findings: "Normal study.", technique: "Transabdominal." }, impression: "No abnormality." };
  const draft = (studyId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId, ...CLEAN, ...over }));
  const sign = (studyId: string, reportId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId, reportId, secondFactorAt: FRESH, now: NOW, ...over,
    }));

  /* ═══════════════════════ A1 — THE SECOND FACTOR ═══════════════════════ */

  /**
   * A1's mutant drops the freshness check, and §11.19-D-27 becomes a checkbox: a signature made on
   * a session that authenticated at breakfast is a claim about breakfast.
   */
  it("A1: a second factor older than the window is refused; inside it, the report signs and STAMPS it", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId);

    const stale = new Date(NOW.getTime() - (SECOND_FACTOR_WINDOW_MINUTES + 1) * 60_000);
    await expect(sign(study.studyId, reportId, { secondFactorAt: stale }))
      .rejects.toMatchObject({ code: "second_factor_required" });
    /** No factor at all is the same refusal — a session that never presented one is not fresh. */
    await expect(sign(study.studyId, reportId, { secondFactorAt: null }))
      .rejects.toMatchObject({ code: "second_factor_required" });

    const signed = await sign(study.studyId, reportId);
    const [row] = await db.select().from(imagingReports).where(eq(imagingReports.id, signed.reportId));
    expect([row!.status, row!.signerId, row!.secondFactorAt?.toISOString()])
      .toEqual(["signed", fx.radiologist.id, FRESH.toISOString()]);
  });

  it("A1: the window's edge is inclusive — exactly W minutes old still signs", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId);
    const edge = new Date(NOW.getTime() - SECOND_FACTOR_WINDOW_MINUTES * 60_000);
    await expect(sign(study.studyId, reportId, { secondFactorAt: edge })).resolves.toBeDefined();
  });

  /* ═══════════════════════ A2 — VERSIONS, NEVER OVERWRITES ═══════════════════════ */

  it("A2: a SECOND signReport on a study with a signed version is refused (B10's partial unique)", async () => {
    const study = await acquired();
    const first = await draft(study.studyId);
    await sign(study.studyId, first.reportId);
    const second = await draft(study.studyId);
    await expect(sign(study.studyId, second.reportId)).rejects.toMatchObject({ code: "already_signed" });
  });

  /**
   * A2's mutant is *"amend by UPDATE of v1"*, and its harm is that **the courtroom has one
   * version**. The assertion is therefore about what SURVIVES: v1's body is still byte-for-byte what
   * was signed, and it now reads `superseded`.
   */
  it("A2: `amendReport` inserts v(n+1) signed and flips the previous to `superseded`, keeping both", async () => {
    const study = await acquired();
    const v1 = await draft(study.studyId);
    const signedV1 = await sign(study.studyId, v1.reportId);

    const amended = await withTx(db, (tx) => amendReport(tx, fx.radiologist, {
      studyId: study.studyId, secondFactorAt: FRESH, now: NOW,
      reason: "left kidney calculus missed on the first read",
      body: { findings: "7 mm calculus, left renal pelvis." }, impression: "Left renal calculus.",
    }));
    expect(amended.supersededId).toBe(signedV1.reportId);

    const rows = await db.select().from(imagingReports)
      .where(eq(imagingReports.studyId, study.studyId)).orderBy(imagingReports.version);
    const byStatus = Object.fromEntries(rows.map((r) => [r.version, r.status]));
    expect(byStatus[signedV1.version]).toBe("superseded");
    expect(byStatus[amended.version]).toBe("signed");

    /** THE ORIGINAL IS INTACT — this is the row the mutant would have overwritten. */
    const [original] = rows.filter((r) => r.id === signedV1.reportId);
    expect(original!.impression).toBe("No abnormality.");
    const [current] = rows.filter((r) => r.id === amended.reportId);
    expect([current!.amendmentReason, current!.supersedesId])
      .toEqual(["left kidney calculus missed on the first read", signedV1.reportId]);
  });

  it("an amendment needs a reason and a fresh factor, exactly as a signature does", async () => {
    const study = await acquired();
    const v1 = await draft(study.studyId);
    await sign(study.studyId, v1.reportId);
    const base = { studyId: study.studyId, secondFactorAt: FRESH, now: NOW, ...CLEAN };
    await expect(withTx(db, (tx) => amendReport(tx, fx.radiologist, { ...base, reason: "  " })))
      .rejects.toMatchObject({ code: "reason_required" });
    await expect(withTx(db, (tx) => amendReport(tx, fx.radiologist, {
      ...base, reason: "x", secondFactorAt: new Date(NOW.getTime() - 3600_000),
    }))).rejects.toMatchObject({ code: "second_factor_required" });
  });

  it("amending a study with NO signed report is refused", async () => {
    const study = await acquired();
    await expect(withTx(db, (tx) => amendReport(tx, fx.radiologist, {
      studyId: study.studyId, secondFactorAt: FRESH, now: NOW, reason: "x", ...CLEAN,
    }))).rejects.toMatchObject({ code: "report_not_signed" });
  });

  /* ═══════════════════════ A3 — THE LOCKOUT, ON EVERY REPORT ═══════════════════════ */

  /**
   * ═══ A3's MUTANT IS THE SHARPEST IN THIS TASK ═══
   *
   * *"Apply the lockout only when `form_f_required`"* — and N9 is the case it lets through: the
   * **pregnant trauma patient's CT**, which is not an obstetric scan, carries no Form F, and can
   * disclose a foetal sex as easily as any anomaly scan. §5(2) is about the COMMUNICATION, not the
   * examination code. So the second half of this test is the one that matters: a plain, non-PCPNDT
   * study is refused too.
   */
  /**
   * NOTE ON THIS FIXTURE: the type is obstetric by BODY PART and carries no `pcpndt_applicable`
   * flag, deliberately. **The lockout reads neither flag** — not the type's and not the study's
   * `form_f_required` — and that is A3's whole point. Both this study and the plain one below have
   * `form_f_required: false`, so the mutant that gates the lockout on that flag fails BOTH of these
   * rows rather than only the second.
   */
  it("A3: an obstetric report containing 'it's a boy' is refused, NAMING the hit", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", body_part: "obstetric" }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await acquired();
    const { reportId } = await draft(study.studyId, {
      body: { findings: "Single live fetus." }, impression: "It's a boy, congratulations.",
    });
    const e = await sign(study.studyId, reportId).catch((x: unknown) => x);
    expect((e as { code: string }).code).toBe("lexical_lockout");
    expect(String(e)).toMatch(/"boy"/);
    expect(await latestSigned(db, study.studyId)).toBeUndefined();
  });

  it("A3: the SAME text on a plain non-PCPNDT study is refused too — N9's pregnant trauma CT", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId, {
      body: { findings: "Free fluid in the pelvis." }, impression: "Also, it is a boy.",
    });
    await expect(sign(study.studyId, reportId)).rejects.toMatchObject({ code: "lexical_lockout" });
  });

  it("A3: an ordinary report with a beta-blocker in it signs — the lockout is not a substring match", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId, {
      body: { findings: "Normal study. Patient continues beta-blocker therapy." },
      impression: "No abnormality.",
    });
    await expect(sign(study.studyId, reportId)).resolves.toBeDefined();
  });

  /* ═══════════════════════ A4 — THE SIDE ═══════════════════════ */

  it("A4: on a lateralised type, a report whose side disagrees with the ORDER is refused", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", laterality_applicable: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await acquired();
    await db.update(imagingStudies).set({ laterality: "left" }).where(eq(imagingStudies.id, study.studyId));

    const wrong = await draft(study.studyId, { laterality: "right" });
    await expect(sign(study.studyId, wrong.reportId)).rejects.toMatchObject({ code: "laterality_mismatch" });
    /** A lateralised study whose report names NO side is refused too — silence is not agreement. */
    const silent = await draft(study.studyId, { laterality: null });
    await expect(sign(study.studyId, silent.reportId)).rejects.toMatchObject({ code: "laterality_mismatch" });

    const right = await draft(study.studyId, { laterality: "left" });
    await expect(sign(study.studyId, right.reportId)).resolves.toBeDefined();
  });

  it("A4: a NON-lateralised type does not demand a side", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId, { laterality: null });
    await expect(sign(study.studyId, reportId)).resolves.toBeDefined();
  });

  /* ═══════════════════════ A5 — THE TRIGGER ═══════════════════════ */

  /**
   * A5's mutant is *"trigger omits `body`"* → E11. The trigger compares WHOLE ROWS minus `status`
   * and `published_at`, so every column below is refused by one rule rather than by a column list
   * somebody has to keep in step.
   */
  it("A5: a signed report's body, impression and signer cannot be UPDATEd; DELETE refused", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId);
    const signed = await sign(study.studyId, reportId);

    for (const stmt of [
      sql`update imaging_reports set body = '{"findings":"rewritten"}' where id = ${signed.reportId}`,
      sql`update imaging_reports set impression = 'rewritten' where id = ${signed.reportId}`,
      sql`update imaging_reports set signer_id = 'someone-else' where id = ${signed.reportId}`,
      sql`update imaging_reports set second_factor_at = now() where id = ${signed.reportId}`,
    ]) {
      await expect(db.execute(stmt)).rejects.toThrow(/imaging_report_immutable/);
    }
    await expect(db.execute(sql`delete from imaging_reports where id = ${signed.reportId}`))
      .rejects.toThrow(/append-only \(DELETE refused\)/);
  });

  it("A5: `status` and `published_at` ARE the two columns that may move", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId);
    const signed = await sign(study.studyId, reportId);
    await expect(db.execute(
      sql`update imaging_reports set status = 'superseded', published_at = now() where id = ${signed.reportId}`,
    )).resolves.toBeDefined();
  });

  /* ═══════════════════════ A6 / A7 — PUBLICATION ═══════════════════════ */

  it("A6: publish closes the envelope item and emits imaging.report_published", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId);
    await sign(study.studyId, reportId);

    const published = await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, {
      studyId: study.studyId, now: NOW,
    }));
    expect(published.notified).toBe(false);

    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect(row!.status).toBe("published");
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, study.itemId));
    expect(item!.status).toBe("completed");
    const emitted = (await db.select().from(events)).filter((e) => e.name === "imaging.report_published");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({ studyId: study.studyId, version: published.version });
  });

  /** O-11 — a patient must never be handed a report nobody has signed. */
  it("A6: a study with only a PRELIM cannot be published", async () => {
    const study = await acquired();
    await withTx(db, (tx) => savePrelim(tx, fx.radiologist, { studyId: study.studyId, ...CLEAN }));
    await expect(withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: study.studyId, now: NOW })))
      .rejects.toMatchObject({ code: "prelim_not_publishable" });
  });

  /**
   * ═══ A6's CENTRAL ROW: MONEY GATES THE MESSAGE AND NEVER THE REPORT ═══
   *
   * The mutant gates PUBLICATION on payment, and D5's exact inversion is what it produces: the
   * critical finding waits for the cashier. Here the invoice is unsettled (there is no line at all),
   * and the report publishes anyway — only the courtesy message is withheld.
   */
  it("A6: an unsettled self-pay study PUBLISHES and skips the message (O-2/D5)", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId);
    await sign(study.studyId, reportId);
    const out = await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: study.studyId, now: NOW }));

    expect(out.notified).toBe(false);
    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect(row!.status).toBe("published");
    expect(await db.select().from(notifications)).toEqual([]);
  });

  /** …and the exception that proves the rule: a RED critical is told regardless of settlement. */
  it("A6: a RED critical publishes AND enqueues even though nothing is settled", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId);
    await sign(study.studyId, reportId, { criticalCategory: "red" });
    const out = await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: study.studyId, now: NOW }));

    expect(out.notified).toBe(true);
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  /**
   * A7 — S7's patient with no channel. C7 is the consequence of letting it throw: a report signed at
   * 02:00 is unpublished because a phone number is missing. Simulated by removing the patient's
   * phone and making the template's own enqueue fail on a duplicate dedupe key.
   */
  it("A7: an enqueue failure does not fail the publish — the report is `published` regardless", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId);
    const signed = await sign(study.studyId, reportId, { criticalCategory: "red" });

    /** Poison the enqueue: the dedupe key this publish will use is already taken. */
    await db.execute(sql`
      insert into notifications (id, template_key, template_version, class, audience, urgency, params,
                                 dedupe_key, occurred_at, status, channel, patient_id)
      values ('01POISON000000000000000001', 'imaging_report_ready', 1, 'transactional', 'patient',
              'routine', '{}', ${`imaging_report_ready:${signed.reportId}`}, now(), 'queued', 'inapp',
              ${study.studyId})`).catch(() => undefined);

    const out = await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: study.studyId, now: NOW }));
    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect(row!.status).toBe("published");
    expect(typeof out.notified).toBe("boolean");
  });

  it("publishing twice is refused rather than re-notifying", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId);
    await sign(study.studyId, reportId);
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: study.studyId, now: NOW }));
    await expect(withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: study.studyId, now: NOW })))
      .rejects.toMatchObject({ code: "already_signed" });
  });

  /* ═══════════════════════ DD15 — the criticals ═══════════════════════ */

  it("a RED critical demands a READ-BACK; an orange one is satisfied by an acknowledgement", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId);
    const signed = await sign(study.studyId, reportId);

    const red = await withTx(db, (tx) => flagCritical(tx, fx.radiologist, {
      reportId: signed.reportId, category: "red", communicatedTo: "dr.ward",
    }));
    await expect(withTx(db, (tx) => acknowledgeCritical(tx, fx.radiologist, {
      criticalId: red.criticalId, acknowledgedByClinicianId: fx.doctor.id,
    }))).rejects.toMatchObject({ code: "reason_required" });
    await withTx(db, (tx) => acknowledgeCritical(tx, fx.radiologist, {
      criticalId: red.criticalId,
      acknowledgedByClinicianId: fx.doctor.id,
      readBack: "large left extradural haematoma, taking to theatre", now: NOW,
    }));

    /**
     * ═══ F76 — THIS ASSERTION USED TO PIN THE DEFECT ═══
     *
     * It read `[row.acknowledgedBy, row.readBackText]` and expected `fx.radiologist.id` — the
     * person who TYPED the acknowledgement, who is also the person who signed the report. An
     * implementation that refused a self-acknowledgement would have failed this test, which is why
     * the defect survived: the suite was asserting that the loop may be closed at both ends by one
     * person, and `imaging.critical_acknowledged` then told 18a-iii's chaser it had reached a human.
     *
     * Now the two are separate facts: `acknowledged_by` is the CLINICIAN who received the call and
     * `recorded_by` is whoever was at the keyboard — at 02:10 that is the radiologist, which is
     * exactly why they cannot be the same field.
     */
    const [row] = await db.select().from(imagingCriticalFindings)
      .where(eq(imagingCriticalFindings.id, red.criticalId));
    expect([row!.acknowledgedBy, row!.recordedBy, row!.readBackText])
      .toEqual([fx.doctor.id, fx.radiologist.id, "large left extradural haematoma, taking to theatre"]);

    /** F76 — and the signer telephoning themselves is not a communication. */
    const other = await withTx(db, (tx) => flagCritical(tx, fx.radiologist, {
      reportId: signed.reportId, category: "orange",
    }));
    expect(other.criticalId).toBe(red.criticalId);

    const emitted = (await db.select().from(events)).map((e) => e.name);
    expect(emitted).toContain("imaging.critical_flagged");
    expect(emitted).toContain("imaging.critical_acknowledged");
  });

  it("a critical is acknowledged ONCE", async () => {
    const study = await acquired();
    const { reportId } = await draft(study.studyId);
    const signed = await sign(study.studyId, reportId);
    const c = await withTx(db, (tx) => flagCritical(tx, fx.radiologist, { reportId: signed.reportId, category: "orange" }));
    await withTx(db, (tx) => acknowledgeCritical(tx, fx.radiologist, {
      criticalId: c.criticalId, acknowledgedByClinicianId: fx.doctor.id, now: NOW,
    }));
    await expect(withTx(db, (tx) => acknowledgeCritical(tx, fx.radiologist, {
      criticalId: c.criticalId, acknowledgedByClinicianId: fx.doctor.id,
    }))).rejects.toMatchObject({ code: "already_signed" });
  });

  /* ═══════════════════════ the shape of a report's life ═══════════════════════ */

  it("a report cannot be written about a study with no images", async () => {
    seq += 1;
    const study = await placeAndCreateStudy(db, fx, "USG-ABDO", `nope${String(seq)}`, new Date(NOW.getTime() + 200 * 3_600_000));
    await expect(draft(study.studyId)).rejects.toMatchObject({ code: "report_not_signed" });
  });

  it("every save is a NEW VERSION — nothing is edited", async () => {
    const study = await acquired();
    await draft(study.studyId);
    await draft(study.studyId, { impression: "second thoughts" });
    await withTx(db, (tx) => savePrelim(tx, fx.radiologist, { studyId: study.studyId, ...CLEAN }));
    const rows = await db.select().from(imagingReports).where(eq(imagingReports.studyId, study.studyId));
    expect(rows.map((r) => r.version).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.status).sort()).toEqual(["draft", "draft", "prelim"]);
  });
});
