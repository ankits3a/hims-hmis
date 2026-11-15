import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture, studyTypeRow } from "../../../test/helpers/radiology";
import { signedCreatinine } from "../../../test/helpers/lab-creatinine";
import {
  alerts, events, imagingDefinitions, imagingSafetyScreenings, notifications, orders, patientAllergies, patients,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { READINESS_ALERT_KIND, readinessForecast } from "./readiness-forecast";
import { rescheduleStudy, scheduleStudy } from "./schedule";
import { counterView } from "./counter";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { StudyType } from "./definitions";
import type { Db } from "../../kernel/db/client";

/**
 * #1084 — the readiness forecast beside its acceptance checks (`acceptance/imaging-prepared-ahead-1084.test.ts`
 * D1–D3): each review reason on its own, the pregnancy screen that is shown and never blocks, a study with
 * nothing to forecast, the move that forecasts again, the ordering doctor's bell, and the desk counter's read.
 * Every instant is handed in.
 */
describe("readinessForecast (#1084)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const DAY_MS = 86_400_000;
  const SLOT = new Date(NOW.getTime() + 3 * DAY_MS);
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: "2026-08-31", now: NOW });
    seq = 0;
    await db.update(imagingDefinitions).set({ body: { types: [
      studyTypeRow({ code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg" }),
      studyTypeRow({ code: "XR-CHEST", service_id: fx.services["XR-CHEST"]!, modality: "xray", ionising: true }),
      studyTypeRow({ code: "CT-HEAD", service_id: fx.services["CT-HEAD"]!, modality: "ct", ionising: true, contrast_option: "required" }),
      studyTypeRow({ code: "MRI-BRAIN", service_id: fx.services["MRI-BRAIN"]!, modality: "mri" }),
    ] satisfies StudyType[] } }).where(eq(imagingDefinitions.kind, "study_types"));
    await db.update(patients).set({ sex: "male", administrativeGender: "male" }).where(eq(patients.id, fx.patientId));
  });
  afterEach(() => { fx.unregister(); });

  const book = async (code: string, device: string, slot = SLOT) => {
    seq += 1;
    const placedAt = new Date(NOW.getTime() + (seq - 1) * 25 * 3_600_000);
    const s = await placeAndCreateStudy(db, fx, code, `rf${String(seq)}`, placedAt);
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId: s.studyId, deviceResourceId: fx.devices[device]!, scheduledAt: slot, now: placedAt }));
    return s;
  };
  const forecastEvents = async () => (await db.select().from(events).where(eq(events.name, "imaging.readiness_forecast")))
    .map((e) => e.payload as Record<string, unknown>);

  it("no creatinine at all: creatinine_missing, a blocker; the message asks for one", async () => {
    const s = await book("CT-HEAD", "ct");
    const f = await readinessForecast(db, s.studyId, SLOT);
    expect([f.verdict, f.kinds, f.blocking, f.creatinine]).toEqual(["creatinine_missing", ["creatinine_missing"], true, null]);
    expect(await forecastEvents()).toEqual([{
      studyId: s.studyId, scheduledAt: SLOT.toISOString(), verdict: "creatinine_missing", kinds: ["creatinine_missing"],
      reviewReasons: [], creatinineResultId: null,
    }]);
    const [msg] = (await db.select().from(notifications)).filter((n) => n.refId === s.studyId);
    expect((msg!.params as { prep: string[] }).prep).toEqual(["nil_by_mouth_4h", "creatinine_report"]);
  });

  it("a valid creatinine with eGFR under the hold level: radiologist_review for the kidney, and the creatinine travels as a pointer", async () => {
    const resultId = await signedCreatinine(db, fx.patientId, "4.00", new Date(NOW.getTime() - DAY_MS));
    const s = await book("CT-HEAD", "ct");
    const f = await readinessForecast(db, s.studyId, SLOT);
    expect([f.verdict, f.reviewReasons, f.creatinine?.resultId, f.creatinine?.validAtSlot]).toEqual(["radiologist_review", ["egfr_below_hold"], resultId, true]);
    expect((await forecastEvents())[0]).toMatchObject({ verdict: "radiologist_review", reviewReasons: ["egfr_below_hold"], creatinineResultId: resultId });
  });

  it("an ACTIVE contrast allergy alone is a review; one entered in error is not", async () => {
    await signedCreatinine(db, fx.patientId, "1.00", new Date(NOW.getTime() - DAY_MS));
    const allergyId = newId();
    await db.insert(patientAllergies).values({
      id: allergyId, patientId: fx.patientId, substance: "Iodinated contrast", severity: "moderate", source: "registration", recordedBy: "t",
    });
    const s = await book("CT-HEAD", "ct");
    expect((await readinessForecast(db, s.studyId, SLOT)).reviewReasons).toEqual(["contrast_allergy"]);
    await db.update(patientAllergies).set({ status: "entered_in_error" }).where(eq(patientAllergies.id, allergyId));
    expect((await readinessForecast(db, s.studyId, SLOT)).verdict).toBe("ready");
  });

  it("a woman in the screening band: pregnancy_screen_due is shown and never blocks — nothing is appended", async () => {
    await db.update(patients).set({ sex: "female", administrativeGender: "female" }).where(eq(patients.id, fx.patientId));
    await signedCreatinine(db, fx.patientId, "0.80", new Date(NOW.getTime() - DAY_MS));
    const s = await book("CT-HEAD", "ct");
    const f = await readinessForecast(db, s.studyId, SLOT);
    expect([f.verdict, f.kinds, f.blocking]).toEqual(["pregnancy_screen_due", ["pregnancy_screen_due"], false]);
    expect(await forecastEvents()).toEqual([]);
  });

  it("a plain X-ray on a man has nothing to forecast", async () => {
    const s = await book("XR-CHEST", "xray");
    expect(await readinessForecast(db, s.studyId, SLOT)).toMatchObject({ verdict: "ready", kinds: [], blocking: false, creatinine: null });
    expect(await forecastEvents()).toEqual([]);
  });

  it("a move forecasts again for the new slot; the ordering doctor, a live user, gets one bell per slot with nobody named", async () => {
    await signedCreatinine(db, fx.patientId, "1.00", new Date(NOW.getTime() - 20 * DAY_MS));
    const s = await book("CT-HEAD", "ct");
    /** Booked within the window (23 days by the slot): ready, nothing appended, no bell. */
    expect(await forecastEvents()).toEqual([]);

    await db.update(orders).set({ orderingClinicianId: fx.doctor.id }).where(eq(orders.id, s.orderId));
    const later = new Date(NOW.getTime() + 15 * DAY_MS);
    await withTx(db, (tx) => rescheduleStudy(tx, fx.radiographer, {
      studyId: s.studyId, deviceResourceId: fx.devices.ct!, scheduledAt: later, reason: "Patient travelling", now: NOW,
    }));
    expect((await forecastEvents()).map((p) => [p.verdict, p.scheduledAt])).toEqual([["creatinine_stale", later.toISOString()]]);
    const bells = await db.select().from(alerts).where(eq(alerts.kind, READINESS_ALERT_KIND));
    expect(bells.map((b) => [b.userId, b.refType, b.refId])).toEqual([[fx.doctor.id, "imaging_study", s.studyId]]);
    expect(`${bells[0]!.title} ${bells[0]!.body}`).not.toMatch(/Asha|HMS-|CT-HEAD/);
    expect(bells[0]!.body).toContain("2026-09-15");
    /** The move's message still asks the patient for one: none is valid by the new slot. */
    const queued = (await db.select().from(notifications)).filter((n) => n.refId === s.studyId && n.status === "queued");
    expect((queued[0]!.params as { prep: string[] }).prep).toContain("creatinine_report");
    /** The forecast opened no gate. */
    expect(await db.select().from(imagingSafetyScreenings).where(eq(imagingSafetyScreenings.studyId, s.studyId))).toHaveLength(0);
  });

  it("the desk counter carries the forecast, and its prep drops the creatinine line when a valid one is on file", async () => {
    await signedCreatinine(db, fx.patientId, "1.00", new Date(NOW.getTime() - DAY_MS));
    const s = await book("CT-HEAD", "ct");
    const v = await counterView(db, fx.radiographer, s.studyId, NOW);
    expect(v.forecast).toMatchObject({ verdict: "ready", slotAt: SLOT.toISOString() });
    expect(v.checks.prep).toEqual(["nil_by_mouth_4h"]);
  });
});
