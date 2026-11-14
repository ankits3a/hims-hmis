import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { acquireStudy, placeAndCreateStudy, setupRadiologyFixture, studyTypeRow } from "../../../../test/helpers/radiology";
import { mkUser } from "../../../../test/helpers/opd";
import { events, imagingDefinitions, imagingStudies, orderItems, orders, patients, phiAccessLog } from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { studyContrastAdministrations, studyContrastReactions, studyView, worklist } from "../read";
import { readingWorklist, reportPrintView } from "../reading";
import { prepBayList } from "../prep-bay";
import { releaseRegister } from "../release";
import { roomView } from "../room";
import { readBackNamesFinding } from "../critical-ladder";
import { checkIn } from "../checkin";
import { scheduleStudy } from "../schedule";
import { evaluateReadiness, requireStudyGate, satisfyGate } from "../gates";
import { startAcquisition } from "../acquisition";
import { recordContrastAdministration } from "../contrast";
import { draftReport, publishReport, signReport } from "../index";
import type { RadiologyFixture } from "../../../../test/helpers/radiology";
import type { StudyType } from "../definitions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1076, spec docs/specs/1076-imaging-quick-wins.md (owner APPROVED 2026-11-14), the
 * server half: list reads logged once per reader, patient and surface per 30 minutes (ruling 0098), full
 * list rows, the recorded contrast in the room view, the hand-over search, the print event, a Devanagari
 * read-back, the `encounter_no` index, and the contrast register read through the study reader.
 *
 * Every reader is handed the clock it runs on: a window measured against a pinned date must never be
 * measured against the real one.
 */
describe("imaging quick wins (spec #1076)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let secondReader: Actor;
  let seq = 0;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const FRESH = new Date(NOW.getTime() - 60_000);
  const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
  const UHID = "HMS-00000001-5";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    const perms = ["radiology.worklist.read", "radiology.reports.read", "radiology.reports.write", "radiology.schedule"];
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: perms, subscriptions: [] });
    await syncPermissions(db, registry);
    for (const p of ["radiology.worklist.read", "radiology.reports.read", "radiology.schedule"]) {
      await grantPermissionToRole(db, registry, "radiographer", p);
    }
    for (const p of ["radiology.worklist.read", "radiology.reports.read", "radiology.reports.write"]) {
      await grantPermissionToRole(db, registry, "radiologist", p);
    }
    ({ actor: secondReader } = await mkUser(db, "rt.two", ["radiographer"]));
    await db.update(imagingDefinitions).set({ body: { types: [
      studyTypeRow({ code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg" }),
      studyTypeRow({ code: "XR-CHEST", service_id: fx.services["XR-CHEST"]!, modality: "xray", ionising: true }),
      studyTypeRow({ code: "CT-HEAD", service_id: fx.services["CT-HEAD"]!, modality: "ct", ionising: true, contrast_option: "required" }),
      studyTypeRow({ code: "MRI-BRAIN", service_id: fx.services["MRI-BRAIN"]!, modality: "mri" }),
    ] satisfies StudyType[] } }).where(eq(imagingDefinitions.kind, "study_types"));
  });
  afterEach(() => { fx.unregister(); });

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  const listRows = (actorId: string) => db.select().from(phiAccessLog)
    .where(and(eq(phiAccessLog.actorId, actorId), eq(phiAccessLog.surface, "imaging.worklist")));

  /** The fixture's study copied onto a new patient: one more person on the floor list. */
  const onePatientMore = async (baseStudyId: string, i: number): Promise<string> => {
    const [s] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, baseStudyId));
    const [o] = await db.select().from(orders).where(eq(orders.id, s!.orderId));
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, s!.orderItemId));
    const patientId = newId();
    await db.insert(patients).values({
      id: patientId, uhid: `HMS-1076${String(i).padStart(4, "0")}-1`, name: `Patient ${String(i)}`, sex: "male",
      administrativeGender: "male", dob: new Date(Date.UTC(1980, 0, 1)), createdBy: "t", updatedBy: "t",
    });
    const orderId = newId();
    await db.insert(orders).values({ ...o!, id: orderId, orderNo: `R1076${String(i)}`, orderGroupId: orderId, patientId });
    const itemId = newId();
    await db.insert(orderItems).values({ ...item!, id: itemId, orderId });
    await db.insert(imagingStudies).values({
      ...s!, id: newId(), orderId, orderItemId: itemId, patientId, accessionNo: `R1076${String(i)}`, workflowInstanceId: newId(),
    });
    return patientId;
  };

  /** Twenty patients, each with one study on the floor list. Returns the study the others copy. */
  const twentyOnTheFloor = async (): Promise<string> => {
    const base = await placeAndCreateStudy(db, fx, "USG-ABDO", "floor0", NOW);
    for (let i = 1; i < 20; i++) await onePatientMore(base.studyId, i);
    return base.studyId;
  };

  const evidenceFor = (kind: string, code: string): unknown => ({
    identity_two_factor: { secondIdentifier: "uhid", value: UHID },
    pregnancy_screen: { declared: true, lmpDate: new Date(NOW.getTime() - 10 * 86_400_000).toISOString() },
    contrast_consent: {
      procedureCode: code, templateVersion: "rad-contrast-v3", language: "hi", signer: "patient",
      conversionCovered: false, laterality: null, signedAt: NOW.toISOString(),
    },
    renal_function: { creatinineUmolL: 72, sampledAt: NOW.toISOString(), source: "internal" },
    prior_contrast_reaction: {},
    laterality_confirm: { patientStated: "na" },
  }[kind] ?? {});

  /** A CT booked with contrast, checked in: its contrast gates open (the prep bay's list). */
  const checkedInCt = async () => {
    seq += 1;
    const study = await placeAndCreateStudy(db, fx, "CT-HEAD", `ct${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000));
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.ct!, scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    return { ...study, gates: checked.gates };
  };

  /** The same CT with every gate cleared and the patient on the table. */
  const ctOnTheTable = async () => {
    const study = await checkedInCt();
    for (const kind of study.gates) {
      const gate = await requireStudyGate(db, study.studyId, kind);
      await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidenceFor(kind, "CT-HEAD"), NOW));
    }
    await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await withTx(db, (tx) => startAcquisition(tx, fx.radiographer, fx.decls, { studyId: study.studyId, now: NOW }));
    return study;
  };

  const acquired = async () => {
    seq += 1;
    return await acquireStudy(db, fx, {
      idemKey: `acq${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
    });
  };

  /** A signed, released report, published at NOW. */
  const released = async () => {
    const s = await acquired();
    const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: s.studyId, body: { findings: "Liver normal." }, impression: "Normal study.",
    }));
    const signed = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: s.studyId, reportId: d.reportId, secondFactorAt: FRESH, now: NOW,
    }));
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: s.studyId, now: NOW }));
    return { ...s, reportId: signed.reportId };
  };

  /* ─────────────────────────── the access log (ruling 0098) ─────────────────────────── */

  it("spec #1076 D1: two worklist reads within 30 minutes over 20 patients leave 20 rows; a 21st patient adds one", async () => {
    const base = await twentyOnTheFloor();
    await worklist(db, fx.radiographer, { view: "floor", now: NOW });
    await worklist(db, fx.radiographer, { view: "floor", now: at(10) });
    expect(await listRows(fx.radiographer.id)).toHaveLength(20);

    const newcomer = await onePatientMore(base, 21);
    await worklist(db, fx.radiographer, { view: "floor", now: at(20) });
    const rows = await listRows(fx.radiographer.id);
    expect(rows).toHaveLength(21);
    expect(rows.filter((r) => r.patientId === newcomer)).toHaveLength(1);
    expect(new Set(rows.map((r) => r.patientId)).size).toBe(21);
  });

  it("spec #1076 D2: a second reader making the same reads in that window gets their own 20 rows", async () => {
    await twentyOnTheFloor();
    await worklist(db, fx.radiographer, { view: "floor", now: NOW });
    await worklist(db, fx.radiographer, { view: "floor", now: at(10) });
    await worklist(db, secondReader, { view: "floor", now: at(12) });
    await worklist(db, secondReader, { view: "floor", now: at(20) });
    expect(await listRows(fx.radiographer.id)).toHaveLength(20);
    const theirs = await listRows(secondReader.id);
    expect(theirs).toHaveLength(20);
    expect(new Set(theirs.map((r) => r.patientId)).size).toBe(20);
  });

  it("spec #1076 D3: on a fixture clock 31 minutes later, the same read by the first reader writes 20 new rows", async () => {
    await twentyOnTheFloor();
    await worklist(db, fx.radiographer, { view: "floor", now: NOW });
    await worklist(db, fx.radiographer, { view: "floor", now: at(10) });
    await worklist(db, fx.radiographer, { view: "floor", now: at(31) });
    const rows = await listRows(fx.radiographer.id);
    expect(rows).toHaveLength(40);
    expect(rows.filter((r) => r.at.getTime() === at(31).getTime())).toHaveLength(20);
    expect(rows.filter((r) => r.at.getTime() === NOW.getTime())).toHaveLength(20);
  });

  it("spec #1076 D4: opening one study twice in a minute writes two rows", async () => {
    const s = await placeAndCreateStudy(db, fx, "USG-ABDO", "one", NOW);
    await studyView(db, fx.radiographer, s.studyId);
    await studyView(db, fx.radiographer, s.studyId);
    const rows = await db.select().from(phiAccessLog)
      .where(and(eq(phiAccessLog.actorId, fx.radiographer.id), eq(phiAccessLog.surface, "imaging.study")));
    expect(rows).toHaveLength(2);
  });

  /* ─────────────────────────────── full list rows ─────────────────────────────── */

  it("spec #1076 D5: the worklist, reading, prep and release rows carry uhid, ageYears, sex and studyTypeName", async () => {
    await placeAndCreateStudy(db, fx, "XR-CHEST", "wl", NOW);
    await checkedInCt();
    await acquired();
    await released();
    const facts = { uhid: UHID, ageYears: 30, sex: "female" };
    /** The book names every study type "Study <code>"; the tariff calls the service "Imaging <code>". */
    const BOOK_NAME = /^Study [A-Z]+-[A-Z]+$/;

    const lists = {
      worklist: await worklist(db, fx.radiographer, { view: "all", now: NOW }),
      reading: await readingWorklist(db, fx.radiologist, NOW),
      prep: await prepBayList(db, fx.radiographer, NOW),
      release: await releaseRegister(db, fx.radiographer, NOW),
    };
    for (const [name, rows] of Object.entries(lists)) {
      expect([name, rows.length > 0]).toEqual([name, true]);
      for (const row of rows as unknown as Record<string, unknown>[]) {
        expect([name, row]).toEqual([name, expect.objectContaining(facts)]);
        expect([name, row.studyTypeName]).toEqual([name, expect.stringMatching(BOOK_NAME)]);
      }
    }
  });

  /* ─────────────────────────────── the room view ─────────────────────────────── */

  it("spec #1076 D7: the room view returns the agent and volume of the one intravenous administration recorded", async () => {
    const s = await ctOnTheTable();
    await withTx(db, (tx) => recordContrastAdministration(tx, fx.radiographer, {
      studyId: s.studyId, agent: "Omnipaque 350", volumeMl: 90, route: "intravenous",
      givenBy: fx.radiographer.id, givenAt: NOW, now: NOW,
    }));
    const view = await roomView(db, fx.radiographer, s.studyId, NOW);
    expect(view.recordedContrast).toEqual({ agent: "Omnipaque 350", volumeMl: 90 });
  });

  /* ─────────────────────────────── the hand-over desk ─────────────────────────────── */

  it("spec #1076 D9: a UHID query finds the patient's report when it is older than the register's window", async () => {
    const r = await released();
    const later = new Date(NOW.getTime() + 40 * 86_400_000);
    const plain = await releaseRegister(db, fx.radiographer, later);
    expect(plain.map((row) => row.reportId)).not.toContain(r.reportId);
    const found = await releaseRegister(db, fx.radiographer, later, { q: UHID });
    expect(found.map((row) => row.reportId)).toContain(r.reportId);
  });

  it("spec #1076 D11: printing a report appends one imaging.report_printed event naming the report and version", async () => {
    const r = await released();
    const view = await reportPrintView(db, fx.radiologist, r.reportId, NOW);
    expect(view?.reportId).toBe(r.reportId);
    const printed = await db.select().from(events).where(eq(events.name, "imaging.report_printed"));
    expect(printed).toHaveLength(1);
    /** The version printed: signing writes a new version row, so a first signature is not always v1. */
    expect(printed[0]!.payload).toEqual(expect.objectContaining({ reportId: r.reportId, version: view!.version }));
  });

  /* ─────────────────────────────── the read-back ─────────────────────────────── */

  it("spec #1076 D12: a Devanagari read-back naming pneumothorax is accepted; 'ठीक है सर' is refused", () => {
    const report = { impression: "Right pneumothorax", findings: null };
    expect(readBackNamesFinding("दायाँ न्यूमोथोरैक्स, समझ गया, चेस्ट ड्रेन लगा रहे हैं", report)).toBe(true);
    expect(readBackNamesFinding("ठीक है सर", report)).toBe(false);
  });

  /* ─────────────────────────────── the index ─────────────────────────────── */

  it("spec #1076 D13: the database has an index on imaging_studies.encounter_no", async () => {
    const rows = await db.execute(sql`select indexdef from pg_indexes where tablename = 'imaging_studies'`);
    const defs = (rows.rows as { indexdef: string }[]).map((r) => r.indexdef);
    expect(defs.some((d) => /\(encounter_no\)/.test(d))).toBe(true);
  });

  /* ─────────────────────────────── the contrast register ─────────────────────────────── */

  it("spec #1076 D14: contrast register reads go through the study reader: logged, and refused to a reader without access", async () => {
    const s = await placeAndCreateStudy(db, fx, "CT-HEAD", "reg", NOW);
    expect(await studyContrastAdministrations(db, fx.radiographer, s.studyId)).toEqual([]);
    expect(await studyContrastReactions(db, fx.radiographer, s.studyId)).toEqual([]);
    const rows = await db.select().from(phiAccessLog)
      .where(and(eq(phiAccessLog.actorId, fx.radiographer.id), eq(phiAccessLog.surface, "imaging.study")));
    expect(rows.map((r) => r.patientId)).toEqual([fx.patientId, fx.patientId]);

    await db.update(orderItems).set({ restricted: true }).where(eq(orderItems.id, s.itemId));
    await expect(studyContrastAdministrations(db, fx.doctor, s.studyId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(studyContrastReactions(db, fx.doctor, s.studyId)).rejects.toMatchObject({ code: "forbidden" });
    expect(await db.select().from(phiAccessLog).where(eq(phiAccessLog.actorId, fx.doctor.id))
      .then((r) => r.filter((x) => x.surface === "imaging.study"))).toEqual([]);
  });
});
