import { and, eq, inArray } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { acquireStudy, placeAndCreateStudy, setupRadiologyFixture, studyTypeRow } from "../../../../test/helpers/radiology";
import { signedCreatinine } from "../../../../test/helpers/lab-creatinine";
import { mkUser } from "../../../../test/helpers/opd";
import {
  events, imagingDefinitions, imagingFollowups, imagingSafetyScreenings, imagingStudies, notifications, orders, patients,
} from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { loadWaiting } from "../../../kernel/desk/waiting";
import * as radiology from "../index";
import { radiologyManifest } from "../manifest";
import { scheduleStudy } from "../schedule";
import { checkIn } from "../checkin";
import { evaluateReadiness, requireStudyGate, satisfyGate } from "../gates";
import { startAcquisition } from "../acquisition";
import { recordContrastAdministration } from "../contrast";
import { recordContrastReaction } from "../reactions";
import { draftReport } from "../report-authoring";
import { signReport } from "../report-signature";
import type { RadiologyFixture } from "../../../../test/helpers/radiology";
import type { StudyType } from "../definitions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1084, spec docs/specs/1084-imaging-prepared-ahead.md (owner APPROVED 2026-11-14), the
 * server half (D1–D5): the readiness forecast at booking, the creatinine line of the appointment message,
 * the protocol suggested from the indication, and a follow-up shown before it falls due.
 *
 * Every instant is written by hand and handed in; nothing here reads the clock. The new acts are looked up
 * on the module's public index, so before the build each check fails on its own line, not on an import.
 *
 * The patient is made MALE for the forecast checks, so the pregnancy screen (a forecast of its own) does not
 * stand in front of the kidney and the contrast-reaction answers these checks are about.
 */
type Fn = (...args: never[]) => unknown;
function act<T extends Fn>(name: string): T {
  const fn = (radiology as Record<string, unknown>)[name];
  expect({ name, type: typeof fn }).toEqual({ name, type: "function" });
  return fn as T;
}

type Forecast = { verdict: string; kinds: string[]; blocking: boolean; reviewReasons: string[] };
type ReadinessForecastFn = (db: Db, studyId: string, slotAt: Date) => Promise<Forecast>;
type Suggestion = { protocol: { name: string }; matchedOn: string; cue: string | null } | null;
type SuggestProtocolFn = (body: unknown, studyTypeCode: string, modality: string, indication: string | null) => Suggestion;

const DAY = "2026-08-31";
/** 11:30 IST on the fixture's service day. */
const NOW = new Date("2026-08-31T06:00:00.000Z");
const DAY_MS = 86_400_000;
/** The booked slot: three days ahead, the spec's own words. */
const SLOT = new Date(NOW.getTime() + 3 * DAY_MS);

describe("spec #1084 — imaging prepared ahead (server)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    await db.update(imagingDefinitions).set({ body: { types: [
      studyTypeRow({ code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg" }),
      studyTypeRow({ code: "XR-CHEST", service_id: fx.services["XR-CHEST"]!, modality: "xray", ionising: true }),
      studyTypeRow({ code: "CT-HEAD", service_id: fx.services["CT-HEAD"]!, modality: "ct", ionising: true, contrast_option: "required" }),
      studyTypeRow({ code: "MRI-BRAIN", service_id: fx.services["MRI-BRAIN"]!, modality: "mri" }),
    ] satisfies StudyType[] } }).where(eq(imagingDefinitions.kind, "study_types"));
    await db.update(patients).set({ sex: "male", administrativeGender: "male" }).where(eq(patients.id, fx.patientId));
  });
  afterEach(() => { fx.unregister(); });

  /** Places a contrast CT at `placedAt` and books it onto the CT at `slot`. */
  const bookContrastCt = async (idem: string, placedAt: Date, slot: Date) => {
    const study = await placeAndCreateStudy(db, fx, "CT-HEAD", idem, placedAt);
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.ct!, scheduledAt: slot, now: placedAt,
    }));
    return study;
  };
  const forecastEvents = async (studyId: string) => (await db.select().from(events)
    .where(eq(events.name, "imaging.readiness_forecast")))
    .filter((e) => (e.payload as { studyId?: string }).studyId === studyId);
  const prepOf = async (studyId: string): Promise<string[]> => {
    const rows = (await db.select().from(notifications)).filter((n) => n.refId === studyId && n.status === "queued");
    expect(rows.map((n) => n.templateKey)).toEqual(["imaging_appointment_booked"]);
    return (rows[0]!.params as { prep: string[] }).prep;
  };

  /* ─────────────────────────────── D1 ─────────────────────────────── */

  it("spec #1084 D1: a contrast CT booked three days ahead with a creatinine older than the valid window forecasts creatinine_stale", async () => {
    const readinessForecast = act<ReadinessForecastFn>("readinessForecast");
    /**
     * Drawn 28 days before booking: inside the OPD window (30 days) today, outside it by the slot (31 days).
     * A forecast measured at the booking instant instead of the slot date would answer `ready`.
     */
    await signedCreatinine(db, fx.patientId, "1.00", new Date(NOW.getTime() - 28 * DAY_MS));
    const study = await bookContrastCt("d1", NOW, SLOT);

    const f = await readinessForecast(db, study.studyId, SLOT);
    expect([f.verdict, f.kinds, f.blocking]).toEqual(["creatinine_stale", ["creatinine_stale"], true]);
    /** A blocker at booking is appended, so the desk and the ordering doctor see it the same day. */
    const appended = await forecastEvents(study.studyId);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.payload).toMatchObject({ studyId: study.studyId, verdict: "creatinine_stale", scheduledAt: SLOT.toISOString() });
    /** None valid on file for the slot, so the message still asks the patient for one. */
    expect(await prepOf(study.studyId)).toContain("creatinine_report");
  });

  /* ─────────────────────────────── D2 ─────────────────────────────── */

  it("spec #1084 D2: with a creatinine from yesterday it forecasts ready, and the appointment message carries no creatinine prep line", async () => {
    const readinessForecast = act<ReadinessForecastFn>("readinessForecast");
    await signedCreatinine(db, fx.patientId, "1.00", new Date(NOW.getTime() - DAY_MS));
    const study = await bookContrastCt("d2", NOW, SLOT);

    const f = await readinessForecast(db, study.studyId, SLOT);
    expect([f.verdict, f.kinds, f.blocking]).toEqual(["ready", [], false]);
    const prep = await prepOf(study.studyId);
    expect(prep).not.toContain("creatinine_report");
    /** Only the creatinine line goes: the fasting instruction for contrast stays. */
    expect(prep).toContain("nil_by_mouth_4h");
    expect(await forecastEvents(study.studyId)).toHaveLength(0);
  });

  /* ─────────────────────────────── D3 ─────────────────────────────── */

  it("spec #1084 D3: with a past contrast reaction on file it forecasts radiologist_review, and no gate row is created or changed", async () => {
    const readinessForecast = act<ReadinessForecastFn>("readinessForecast");

    /** The past reaction, recorded the way the room records one: on an earlier contrast CT, on the table. */
    const prior = await placeAndCreateStudy(db, fx, "CT-HEAD", "d3-prior", NOW);
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: prior.studyId, deviceResourceId: fx.devices.ct!, scheduledAt: new Date(NOW.getTime() + 3_600_000), now: NOW,
    }));
    const opened = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: prior.studyId, now: NOW }));
    const evidence: Record<string, unknown> = {
      identity_two_factor: { secondIdentifier: "uhid", value: "HMS-00000001-5", nameStated: true },
      contrast_consent: {
        procedureCode: "CT-HEAD", templateVersion: "rad-contrast-v3", language: "hi",
        signer: "patient", conversionCovered: false, laterality: null, signedAt: NOW.toISOString(),
      },
      renal_function: { creatinineUmolL: 72, sampledAt: NOW.toISOString(), source: "internal" },
      prior_contrast_reaction: {},
    };
    for (const kind of opened.gates) {
      const gate = await requireStudyGate(db, prior.studyId, kind);
      await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidence[kind] ?? {}, NOW));
    }
    await withTx(db, (tx) => evaluateReadiness(tx, prior.studyId));
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, prior.studyId));
    await withTx(db, (tx) => startAcquisition(tx, fx.radiographer, fx.decls, { studyId: prior.studyId, now: NOW }));
    const { administrationId } = await withTx(db, (tx) => recordContrastAdministration(tx, fx.radiographer, {
      studyId: prior.studyId, agent: "Omnipaque 350", volumeMl: 90, route: "intravenous",
      givenBy: fx.radiographer.id, givenAt: NOW, now: NOW,
    }));
    await withTx(db, (tx) => recordContrastReaction(tx, fx.radiographer, {
      administrationId, severity: "moderate", onset: "immediate", manifestation: "urticaria and wheeze on the table",
      observedBy: fx.radiographer.id, observedAt: new Date(NOW.getTime() + 120_000), now: new Date(NOW.getTime() + 180_000),
    }));

    /** A day later (outside the 24-hour duplicate window), the next contrast CT, with a fresh creatinine. */
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    const slot = new Date(later.getTime() + 3 * DAY_MS);
    await signedCreatinine(db, fx.patientId, "1.00", new Date(later.getTime() - DAY_MS));
    const study = await bookContrastCt("d3", later, slot);
    const gatesOf = () => db.select().from(imagingSafetyScreenings).where(eq(imagingSafetyScreenings.studyId, study.studyId));
    const gateEvents = async () => (await db.select().from(events).where(eq(events.name, "imaging.gate_evaluated"))).length;

    const f = await readinessForecast(db, study.studyId, slot);
    expect([f.verdict, f.blocking]).toEqual(["radiologist_review", true]);
    expect(f.reviewReasons).toContain("past_contrast_reaction");
    expect((await forecastEvents(study.studyId)).map((e) => (e.payload as { verdict: string }).verdict)).toEqual(["radiologist_review"]);
    /** Booking and forecasting opened nothing: gates are check-in's to open. */
    expect(await gatesOf()).toHaveLength(0);

    /** On the day: check-in opens the gates; a forecast read then changes none of them and evaluates none. */
    await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: slot }));
    const before = await gatesOf();
    const evaluated = await gateEvents();
    expect(before.length).toBeGreaterThan(0);
    expect((await readinessForecast(db, study.studyId, slot)).verdict).toBe("radiologist_review");
    expect(await gatesOf()).toEqual(before);
    expect(await gateEvents()).toBe(evaluated);
  });

  /* ─────────────────────────────── D4 ─────────────────────────────── */

  it("spec #1084 D4: suggestProtocol returns the protocol whose cue matches the indication and names the cue; with no match the study type's default", () => {
    const suggestProtocol = act<SuggestProtocolFn>("suggestProtocol");
    const parse = radiology.parseDefinitionBody;
    const book = parse("imaging_protocols", {
      protocols: [
        { study_type_code: "CT-ABD", name: "CT abdomen, portal venous", technique: "Portal venous phase, 70 s." },
        { study_type_code: "CT-ABD", name: "CT KUB, plain", technique: "Plain, prone, kidneys to bladder.", indication_cues: ["renal colic", "ureteric stone"] },
        { study_type_code: "CT-ABD", name: "CT abdomen, triple phase", technique: "Arterial, portal, delayed.", indication_cues: ["liver lesion", "HCC"] },
        { modality: "ct", name: "CT, department default", technique: "As the radiologist directs." },
      ],
    });

    const colic = suggestProtocol(book, "CT-ABD", "ct", "Left renal colic since this morning, haematuria");
    expect([colic?.protocol.name, colic?.matchedOn, colic?.cue]).toEqual(["CT KUB, plain", "indication_cue", "renal colic"]);
    const hcc = suggestProtocol(book, "CT-ABD", "ct", "Known hcc, rising AFP");
    expect([hcc?.protocol.name, hcc?.cue]).toEqual(["CT abdomen, triple phase", "HCC"]);

    const none = suggestProtocol(book, "CT-ABD", "ct", "Pain abdomen for two days");
    expect([none?.protocol.name, none?.matchedOn, none?.cue]).toEqual(["CT abdomen, portal venous", "study_type", null]);

    /** A book written before cues existed still parses (publishing validates the same way) and still answers. */
    const old = parse("imaging_protocols", { protocols: [{ study_type_code: "CT-ABD", name: "CT abdomen", technique: "Portal venous." }] });
    const plain = suggestProtocol(old, "CT-ABD", "ct", "Renal colic");
    expect([plain?.protocol.name, plain?.matchedOn, plain?.cue]).toEqual(["CT abdomen", "study_type", null]);
  });

  /* ─────────────────────────────── D5 ─────────────────────────────── */

  it("spec #1084 D5: a follow-up due in 10 days appears in the treating doctor's waiting items; one due in 20 days does not", async () => {
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: ["radiology.reports.read"], subscriptions: [] });
    await syncPermissions(db, registry);
    await grantPermissionToRole(db, registry, "doctor", "radiology.reports.read");
    const { actor: treating } = await mkUser(db, "dr.treating", ["doctor"]);

    const signed = async (idem: string, offsetH: number) => {
      const at = new Date(NOW.getTime() + offsetH * 3_600_000);
      const s = await acquireStudy(db, fx, { idemKey: idem, now: at, slot: new Date(at.getTime() + 3_600_000) });
      await db.update(orders).set({ orderingClinicianId: treating.id }).where(eq(orders.id, s.orderId));
      const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
        studyId: s.studyId, body: { findings: "Simple cyst.", followup: { text: "Repeat ultrasound", months: 6 } }, impression: "As above.",
      }));
      await withTx(db, (tx) => signReport(tx, fx.radiologist, {
        studyId: s.studyId, reportId: d.reportId, secondFactorAt: new Date(at.getTime() - 60_000), now: at,
      }));
      return s;
    };
    const soon = await signed("d5-soon", 0);
    const later = await signed("d5-later", 25);

    /** The day the doctor looks, and two due dates measured from it. */
    const looking = new Date("2026-09-10T05:00:00.000Z");
    const plusDays = (n: number) => new Date(Date.parse("2026-09-10T00:00:00.000Z") + n * DAY_MS).toISOString().slice(0, 10);
    await db.update(imagingFollowups).set({ dueOn: plusDays(10) }).where(eq(imagingFollowups.studyId, soon.studyId));
    await db.update(imagingFollowups).set({ dueOn: plusDays(20) }).where(eq(imagingFollowups.studyId, later.studyId));
    expect((await db.select().from(imagingFollowups)
      .where(and(inArray(imagingFollowups.studyId, [soon.studyId, later.studyId]), eq(imagingFollowups.state, "open")))).length).toBe(2);

    const ctx = (who: Actor) => ({ db, actor: who, reader: who, date: "2026-09-10", now: looking });
    const { items } = await loadWaiting(radiologyManifest.desk ?? [], ctx(treating));
    const line = items.find((i) => i.kind === ("radiology.followupsDue" as never));
    expect(line).toMatchObject({ kind: "radiology.followupsDue", count: 1 });
    /** The consult's results inbox, where "Book it" — the existing act — sits beside each follow-up. */
    expect(line?.href).toBe("/opd/consult");

    /** Another doctor is not the treating doctor and is shown nothing. */
    const { actor: other } = await mkUser(db, "dr.other", ["doctor"]);
    const theirs = await loadWaiting(radiologyManifest.desk ?? [], ctx(other));
    expect(theirs.items.find((i) => i.kind === ("radiology.followupsDue" as never))).toBeUndefined();
  });
});
