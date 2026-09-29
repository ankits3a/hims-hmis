import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { setupRadiologyFixture, startStudyOnMachine } from "../../../test/helpers/radiology";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import {
  doseRegister, events, imagingDefinitions, imagingDoseSrReceipts, imagingStudies, imagingUnmatchedStudies,
  phiAccessLog,
} from "../../kernel/db/schema";
import { recordAcquired } from "./acquisition";
import { roomView } from "./room";
import { pacsSettingsBodySchema, doseReferenceLevelsBodySchema } from "./definitions";
import {
  PACS_INTERFACE, PACS_RECONCILE, attachUnmatched, doseDisagreement, ingestArrival, ingestDoseSr, pacsInbox,
  parseDoseSr, parseOrthancStudy, rejectUnmatched,
} from "./pacs";
import { mintStudyInstanceUid } from "./uid";
import { runCensus } from "../../../scripts/standup-check";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS12 — the PACS seams without the hardware: Orthanc's study JSON and a Radiation Dose
 * SR's simplified tags are RECORDED FIXTURES below (the shapes Orthanc 1.12 returns for
 * `GET /studies/{id}` + `/statistics` and `GET /instances/{id}/tags?simplify`); no archive runs.
 */
describe("PACS seams (18-S RS12)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let bridge: Actor;
  let seq = 0;

  const DAY = "2026-08-31";
  const NOW = new Date(`${DAY}T06:00:00.000Z`);
  const LATER = new Date(`${DAY}T06:20:00.000Z`);
  const slot = () => new Date(`${DAY}T${String(9 + seq).padStart(2, "0")}:00:00.000Z`);
  const UHID_A = "HMS-00000001-5";
  const UHID_B = "HMS-00000002-3";

  /** Orthanc 1.12 `GET /studies/{id}` (trimmed to the tags it always returns) + `/statistics`. */
  const orthanc = (o: { uid: string; accession?: string | null; patientId?: string | null; series?: number; instances?: number }) => ({
    study: {
      ID: `orth-${o.uid.slice(-6)}`, Type: "Study", IsStable: true, LastUpdate: "20260831T063000",
      MainDicomTags: {
        StudyInstanceUID: o.uid, AccessionNumber: o.accession ?? "", StudyDate: "20260831", StudyTime: "113000",
        StudyDescription: "CT HEAD PLAIN", ModalitiesInStudy: "CT\\SR", ReferringPhysicianName: "",
      },
      PatientMainDicomTags: { PatientID: o.patientId ?? "", PatientName: "DEVI^ASHA", PatientBirthDate: "19960101", PatientSex: "F" },
      Series: Array.from({ length: o.series ?? 3 }, (_, i) => `ser-${String(i)}`),
    },
    statistics: { CountPatients: 1, CountStudies: 1, CountSeries: o.series ?? 3, CountInstances: o.instances ?? 212, DiskSize: "110000000", DiskSizeMB: 104 },
  });

  const num = (code: string, meaning: string, value: string, unit: string) => ({
    RelationshipType: "CONTAINS", ValueType: "NUM",
    ConceptNameCodeSequence: [{ CodeValue: code, CodingSchemeDesignator: "DCM", CodeMeaning: meaning }],
    MeasuredValueSequence: [{ NumericValue: value, MeasurementUnitsCodeSequence: [{ CodeValue: unit, CodingSchemeDesignator: "UCUM" }] }],
  });
  const container = (code: string, meaning: string, children: unknown[]) => ({
    RelationshipType: "CONTAINS", ValueType: "CONTAINER",
    ConceptNameCodeSequence: [{ CodeValue: code, CodingSchemeDesignator: "DCM", CodeMeaning: meaning }],
    ContentSequence: children,
  });
  /** A CT Radiation Dose SR, TID 10011: two acquisitions and the accumulated total. */
  const ctSr = (o: { sop: string; uid: string; accession?: string; patientId?: string; ctdi?: [string, string]; dlpTotal?: string }) => ({
    tags: {
      SOPClassUID: "1.2.840.10008.5.1.4.1.1.88.67", SOPInstanceUID: o.sop, StudyInstanceUID: o.uid,
      AccessionNumber: o.accession ?? "", PatientID: o.patientId ?? UHID_A, Modality: "SR",
      ContentTemplateSequence: [{ MappingResource: "DCMR", TemplateIdentifier: "10011" }],
      ContentSequence: [
        container("113811", "CT Accumulated Dose Data", [
          num("113812", "Total Number of Irradiation Events", "2", "{events}"),
          num("113813", "CT Dose Length Product Total", o.dlpTotal ?? "845.6", "mGy.cm"),
        ]),
        container("113819", "CT Acquisition", [container("113829", "CT Dose", [
          num("113830", "Mean CTDIvol", o.ctdi?.[0] ?? "52.1", "mGy"), num("113838", "DLP", "420.1", "mGy.cm"),
        ])]),
        container("113819", "CT Acquisition", [container("113829", "CT Dose", [
          num("113830", "Mean CTDIvol", o.ctdi?.[1] ?? "48.7", "mGy"), num("113838", "DLP", "425.5", "mGy.cm"),
        ])]),
      ],
    },
  });

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    seq = 0;
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: [PACS_INTERFACE, PACS_RECONCILE], subscriptions: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "modality_bridge");
    await grantPermissionToRole(db, registry, "modality_bridge", PACS_INTERFACE);
    await grantPermissionToRole(db, registry, "radiographer", PACS_RECONCILE);
    ({ actor: bridge } = await mkUser(db, "bridge.one", ["modality_bridge"]));
  });
  afterEach(() => { fx.unregister(); });

  /** CT by default; a second study in one test is an X-ray (the 24-hour duplicate-order rule refuses a second CT head). */
  const onTable = async (xray = false) => {
    seq += 1;
    return startStudyOnMachine(db, fx, {
      serviceCode: xray ? "XR-CHEST" : "CT-HEAD", deviceKey: xray ? "xray" : "ct", idemKey: `p${String(seq)}`, now: NOW, slot: slot(),
    });
  };
  const acquiredCt = async (dose: { doseCtdivol?: number; doseDlp?: number } = { doseCtdivol: 52, doseDlp: 846 }) => {
    const s = await onTable();
    await withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, { studyId: s.studyId, imageSource: "pacs", ...dose, doseManual: true, now: NOW }));
    return s;
  };
  const arrive = (body: unknown, at = LATER) => withTx(db, (tx) => ingestArrival(tx, bridge, parseOrthancStudy(body), at));
  const studyRow = async (id: string) => (await db.select().from(imagingStudies).where(eq(imagingStudies.id, id)))[0]!;
  const eventsNamed = async (name: string) => db.select().from(events).where(eq(events.name, name));

  /* ═════════════════════ T1 — the arrival notice ═════════════════════ */

  it("T1 parse: Orthanc's study JSON becomes a notice; a notice with no valid Study Instance UID is refused", () => {
    const n = parseOrthancStudy(orthanc({ uid: "1.2.840.113619.2.55.3.1", accession: "X2608310001", patientId: UHID_A, series: 4, instances: 300 }));
    expect(n).toEqual({
      studyInstanceUid: "1.2.840.113619.2.55.3.1", accessionNumber: "X2608310001", patientId: UHID_A,
      patientName: "DEVI^ASHA", modality: "CT", studyDate: "2026-08-31", seriesCount: 4, instanceCount: 300, archiveRef: "orth-55.3.1",
    });
    expect(() => parseOrthancStudy(orthanc({ uid: "" }))).toThrow(expect.objectContaining({ code: "invalid_pacs_notice" }));
    expect(() => parseOrthancStudy(orthanc({ uid: "1.2.03.4" }))).toThrow(expect.objectContaining({ code: "invalid_pacs_notice" }));
    expect(() => parseOrthancStudy({ nothing: true })).toThrow(expect.objectContaining({ code: "invalid_pacs_notice" }));
  });

  it("T1 match: the worklist's accession + UHID come back → the study holds the archive's images; a re-send refreshes counts and emits nothing", async () => {
    const s = await acquiredCt();
    const uid = mintStudyInstanceUid(s.studyId);
    const out = await arrive(orthanc({ uid, accession: s.accessionNo, patientId: UHID_A, series: 3, instances: 212 }));
    expect(out).toEqual({ outcome: "matched", studyId: s.studyId, accessionNo: s.accessionNo, repeat: false });
    const row = await studyRow(s.studyId);
    expect(row).toMatchObject({ imageSource: "pacs", studyInstanceUid: uid, imageSeriesCount: 3, imageInstanceCount: 212 });
    expect(row.imagesArrivedAt).toEqual(LATER);

    const again = await arrive(orthanc({ uid, accession: s.accessionNo, patientId: UHID_A, series: 4, instances: 260 }));
    expect(again).toMatchObject({ outcome: "matched", repeat: true });
    expect(await studyRow(s.studyId)).toMatchObject({ imageSeriesCount: 4, imageInstanceCount: 260 });
    expect(await eventsNamed("imaging.images_arrived")).toHaveLength(1);
    expect(await db.select().from(imagingUnmatchedStudies)).toHaveLength(0);
  });

  it("T1 MISMATCH: patient A's accession carrying patient B's PatientID is held, NOT attached — A's study is untouched", async () => {
    const a = await acquiredCt();
    const out = await arrive(orthanc({ uid: "1.2.3.4.5.6.7", accession: a.accessionNo, patientId: UHID_B }));
    expect(out).toMatchObject({ outcome: "unmatched", reason: "patient_mismatch" });
    const row = await studyRow(a.studyId);
    expect(row.imagesArrivedAt).toBeNull();
    expect(row.studyInstanceUid).toBe(mintStudyInstanceUid(a.studyId));
    const [held] = await db.select().from(imagingUnmatchedStudies);
    expect(held).toMatchObject({ reason: "patient_mismatch", candidateStudyId: a.studyId, status: "open", dicomPatientId: UHID_B });
    expect(await eventsNamed("imaging.images_arrived")).toHaveLength(0);
  });

  it("T1: a PatientID that is blank is not a match either (the UHID must agree, never assumed)", async () => {
    const a = await acquiredCt();
    expect(await arrive(orthanc({ uid: "1.2.3.4.5.6.8", accession: a.accessionNo, patientId: null })))
      .toMatchObject({ outcome: "unmatched", reason: "patient_mismatch" });
  });

  it("T1: nothing to claim it → one inbox row, and a re-send is the SAME row (idempotent on the UID)", async () => {
    const first = await arrive(orthanc({ uid: "1.2.3.9", accession: "X9999999999", patientId: UHID_A, instances: 10 }));
    const second = await arrive(orthanc({ uid: "1.2.3.9", accession: "X9999999999", patientId: UHID_A, instances: 12 }));
    expect(first).toMatchObject({ outcome: "unmatched", reason: "no_match" });
    expect(second).toMatchObject({ outcome: "unmatched", unmatchedId: (first as { unmatchedId: string }).unmatchedId });
    const rows = await db.select().from(imagingUnmatchedStudies);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.instanceCount).toBe(12);
    expect(await arrive(orthanc({ uid: "1.2.3.10", accession: null, patientId: null }))).toMatchObject({ reason: "no_identifiers" });
  });

  it("T1: a blank accession still matches by the worklist's UID — with the UHID", async () => {
    const s = await acquiredCt();
    const out = await arrive(orthanc({ uid: mintStudyInstanceUid(s.studyId), accession: null, patientId: UHID_A }));
    expect(out).toMatchObject({ outcome: "matched", studyId: s.studyId });
  });

  it("T1: images before Send wait on the study, and Send records the ARCHIVE's UID and attaches them", async () => {
    const s = await onTable();
    const uid = "1.3.12.2.1107.5.1.4.99";
    expect(await arrive(orthanc({ uid, accession: s.accessionNo, patientId: UHID_A, instances: 180 })))
      .toMatchObject({ outcome: "unmatched", reason: "awaiting_acquisition" });
    await withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, { studyId: s.studyId, imageSource: "pacs", doseDlp: 800, now: LATER }));
    expect(await studyRow(s.studyId)).toMatchObject({ studyInstanceUid: uid, imageInstanceCount: 180, imageSource: "pacs" });
    const [held] = await db.select().from(imagingUnmatchedStudies);
    expect(held).toMatchObject({ status: "attached", resolvedStudyId: s.studyId, resolvedBy: null });
    const [ev] = await eventsNamed("imaging.images_arrived");
    expect(ev!.payload).toMatchObject({ via: "send", studyId: s.studyId });
  });

  it("T1: a typed UID that the archive contradicts — acquired as the machine's UID, the archive's a second study — goes to a human", async () => {
    const s = await onTable();
    await withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, {
      studyId: s.studyId, imageSource: "pacs", studyInstanceUid: "1.2.826.0.1.1", doseDlp: 800, now: NOW,
    }));
    expect(await arrive(orthanc({ uid: "1.2.826.0.1.2", accession: s.accessionNo, patientId: UHID_A })))
      .toMatchObject({ outcome: "unmatched", reason: "uid_mismatch" });
  });

  it("T1: only the bridge's permission posts a notice", async () => {
    await expect(withTx(db, (tx) => ingestArrival(tx, fx.radiographer, parseOrthancStudy(orthanc({ uid: "1.2.3" })), NOW)))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  /* ═════════════════════ T2 — the dose report ═════════════════════ */

  it("T2 parse: TID 10011 — CTDIvol is the highest acquisition's, DLP the accumulated total", () => {
    const n = parseDoseSr(ctSr({ sop: "1.2.9.1", uid: "1.2.9", accession: "X1", patientId: UHID_A }));
    expect(n).toMatchObject({ template: "ct_10011", ctdivol: 52.1, dlp: 845.6, dap: null, fluoroSeconds: null, agd: null, sopInstanceUid: "1.2.9.1" });
  });

  it("T2 parse: TID 10001 — DAP in Gy·m² becomes Gy·cm² (×10,000), fluoro time in seconds, AGD the higher breast; an unknown unit is dropped", () => {
    const tags = {
      SOPClassUID: "1.2.840.10008.5.1.4.1.1.88.67", SOPInstanceUID: "1.2.7.1", StudyInstanceUID: "1.2.7", PatientID: UHID_A,
      ContentTemplateSequence: [{ TemplateIdentifier: "10001" }],
      ContentSequence: [container("113702", "Accumulated X-Ray Dose Data", [
        num("113722", "Dose Area Product Total", "0.000245", "Gy.m2"),
        num("113730", "Total Fluoro Time", "74.6", "s"),
        num("111637", "Accumulated Average Glandular Dose", "1.42", "mGy"),
        num("111637", "Accumulated Average Glandular Dose", "1.61", "mGy"),
        num("113725", "Dose (RP) Total", "12", "furlong"),
      ])],
    };
    expect(parseDoseSr({ tags })).toMatchObject({ template: "projection_10001", dap: 2.45, fluoroSeconds: 75, agd: 1.61 });
    const unknownUnit = { ...tags, ContentSequence: [container("113702", "Acc", [num("113722", "DAP", "3", "furlongs")])] };
    expect(() => parseDoseSr({ tags: unknownUnit })).toThrow(expect.objectContaining({ code: "invalid_pacs_notice" }));
  });

  it("T2: an SR before Send, no number typed → the register is written from the SR through recordDose, the DRL compared, origin dose_sr", async () => {
    await db.insert(imagingDefinitions).values({
      id: newId(), kind: "dose_reference_levels", version: 1, status: "active",
      body: { levels: [{ study_type_code: "CT-HEAD", quantity: "ctdivol", value: 50 }] },
      draftedBy: fx.radiologist.id, publishedBy: fx.radiologist.id, publishedAt: NOW,
    });
    const s = await onTable();
    const r = await withTx(db, (tx) => ingestDoseSr(tx, bridge, parseDoseSr(ctSr({ sop: "1.2.9.1", uid: "1.2.9", accession: s.accessionNo })), NOW));
    expect(r).toMatchObject({ outcome: "pending", studyId: s.studyId });
    await withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, { studyId: s.studyId, imageSource: "pacs", now: LATER }));
    const [reg] = await db.select().from(doseRegister).where(eq(doseRegister.sourceRef, s.studyId));
    expect(reg).toMatchObject({ doseOrigin: "dose_sr", doseCtdivol: "52.100", doseDlp: "845.600", doseManual: false, drlQuantity: "ctdivol", overDrl: true });
    const [rc] = await db.select().from(imagingDoseSrReceipts);
    expect(rc).toMatchObject({ outcome: "recorded" });
    expect(await studyRow(s.studyId)).toMatchObject({ doseCtdivol: "52.100" });
  });

  it("T2: the room console's read carries the waiting dose report, so the technologist sees it before Send", async () => {
    const s = await onTable();
    expect((await roomView(db, fx.radiographer, s.studyId, NOW)).doseReport).toBeNull();
    await withTx(db, (tx) => ingestDoseSr(tx, bridge, parseDoseSr(ctSr({ sop: "1.2.9.8", uid: "1.2.9.88", accession: s.accessionNo })), NOW));
    expect((await roomView(db, fx.radiographer, s.studyId, NOW)).doseReport).toEqual({ ctdivol: 52.1, dlp: 845.6, dap: null, fluoroSeconds: null, agd: null });
  });

  it("T2: a typed number is never overwritten — an SR that disagrees is kept as a conflict, one that agrees is confirmed", async () => {
    const s = await acquiredCt({ doseCtdivol: 52, doseDlp: 84.6 }); // DLP typed out by a factor of ten
    const conflict = await withTx(db, (tx) => ingestDoseSr(tx, bridge, parseDoseSr(ctSr({ sop: "1.2.9.2", uid: mintStudyInstanceUid(s.studyId), accession: s.accessionNo })), LATER));
    expect(conflict).toMatchObject({ outcome: "conflict", studyId: s.studyId });
    const [reg] = await db.select().from(doseRegister).where(eq(doseRegister.sourceRef, s.studyId));
    expect(reg).toMatchObject({ doseOrigin: "manual", doseDlp: "84.600", doseCtdivol: "52.000" });
    const [rc] = await db.select().from(imagingDoseSrReceipts).where(eq(imagingDoseSrReceipts.sopInstanceUid, "1.2.9.2"));
    expect(rc!.conflict).toEqual({ dlp: { typed: 84.6, sr: 845.6 } });
  });

  it("T2: an SR that agrees with the typed numbers is confirmed, and a re-sent SR is the same receipt", async () => {
    const t = await acquiredCt({ doseCtdivol: 52.1, doseDlp: 846 });
    expect(await withTx(db, (tx) => ingestDoseSr(tx, bridge, parseDoseSr(ctSr({ sop: "1.2.9.3", uid: "1.2.9.33", accession: t.accessionNo })), LATER)))
      .toMatchObject({ outcome: "confirmed" });
    // Idempotent on the SOP Instance UID.
    expect(await withTx(db, (tx) => ingestDoseSr(tx, bridge, parseDoseSr(ctSr({ sop: "1.2.9.3", uid: "1.2.9.33", accession: t.accessionNo })), LATER)))
      .toMatchObject({ outcome: "confirmed", repeat: true });
    expect(await db.select().from(imagingDoseSrReceipts)).toHaveLength(1);
  });

  it("T2: a dose report naming patient A's accession with patient B's ID is not placed on A", async () => {
    const s = await onTable();
    const r = await withTx(db, (tx) => ingestDoseSr(tx, bridge, parseDoseSr(ctSr({ sop: "1.2.9.4", uid: "1.2.9.44", accession: s.accessionNo, patientId: UHID_B })), NOW));
    expect(r).toMatchObject({ outcome: "unmatched", studyId: null });
    // With nothing pending for A, Send still needs a typed dose.
    await expect(withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, { studyId: s.studyId, imageSource: "pacs", now: LATER })))
      .rejects.toMatchObject({ code: "dose_required" });
  });

  it("T2: AGD is a register quantity — a mammography-style AGD alone satisfies the dose rule, and a DRL can be set on it", async () => {
    const s = await onTable();
    await withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, { studyId: s.studyId, imageSource: "no_pacs_images", doseAgd: 1.6, now: NOW }));
    const [reg] = await db.select().from(doseRegister).where(eq(doseRegister.sourceRef, s.studyId));
    expect(reg).toMatchObject({ doseAgd: "1.600", doseOrigin: "manual" });
    expect(doseReferenceLevelsBodySchema.safeParse({ levels: [{ modality: "mammography", quantity: "agd", value: 2.5 }] }).success).toBe(true);
  });

  it("T2: agreement is within 2 % or 0.05 of the register's unit; a factor-of-ten slip is a conflict", () => {
    const base = { ctdivol: null, dlp: null, dap: null, fluoroSeconds: null, agd: null };
    expect(doseDisagreement({ ...base, ctdivol: 12.4 }, { ...base, ctdivol: 12.37 })).toBeNull();
    expect(doseDisagreement({ ...base, dap: 2.45 }, { ...base, dap: 24.5 })).toEqual({ dap: { typed: 2.45, sr: 24.5 } });
    expect(doseDisagreement({ ...base, dlp: 800 }, { ...base, ctdivol: 50 })).toBeNull();
  });

  /* ═════════════════════ T3 — the inbox ═════════════════════ */

  it("T3: the inbox lists the held study with its candidate; attaching needs a reason, updates the study, leaves the queue, is evented and PHI-logged", async () => {
    const a = await acquiredCt();
    const held = await arrive(orthanc({ uid: "1.2.5.1", accession: a.accessionNo, patientId: "HMS-0000001-5" /* a typo at the console */ }));
    const unmatchedId = (held as { unmatchedId: string }).unmatchedId;
    // A dose report for the same archive study came in before anyone could place it.
    await withTx(db, (tx) => ingestDoseSr(tx, bridge, parseDoseSr(ctSr({ sop: "1.2.5.1.9", uid: "1.2.5.1", patientId: "HMS-0000001-5" })), LATER));

    const inbox = await pacsInbox(db, fx.radiographer);
    expect(inbox.unmatched).toHaveLength(1);
    expect(inbox.unmatched[0]).toMatchObject({ id: unmatchedId, reason: "patient_mismatch", candidate: { studyId: a.studyId, patientName: "Asha Devi", uhid: UHID_A } });
    expect(inbox.doseUnmatched).toBe(1);
    expect(inbox.configured).toBe(false);

    await expect(withTx(db, (tx) => attachUnmatched(tx, fx.radiographer, { unmatchedId, accessionNo: a.accessionNo, reason: "  " })))
      .rejects.toMatchObject({ code: "reason_required" });
    const phiBefore = (await db.select().from(phiAccessLog)).length;
    const out = await withTx(db, (tx) => attachUnmatched(tx, fx.radiographer, {
      unmatchedId, accessionNo: a.accessionNo, reason: "UHID typed with a digit missing at the CT console; same patient on the table", now: LATER,
    }));
    expect(out).toEqual({ studyId: a.studyId, accessionNo: a.accessionNo });
    expect(await studyRow(a.studyId)).toMatchObject({ studyInstanceUid: "1.2.5.1", imageSource: "pacs" });
    const [row] = await db.select().from(imagingUnmatchedStudies);
    expect(row).toMatchObject({ status: "attached", resolvedBy: fx.radiographer.id, resolvedStudyId: a.studyId });
    expect((await pacsInbox(db, fx.radiographer)).unmatched).toHaveLength(0);
    const [ev] = await eventsNamed("imaging.images_reconciled");
    expect(ev!.payload).toEqual({ unmatchedId, outcome: "attached", studyId: a.studyId, unmatchedReason: "patient_mismatch" });
    expect((await db.select().from(phiAccessLog)).length).toBeGreaterThan(phiBefore);
    // The dose report followed the images and was compared with the typed register row.
    const [rc] = await db.select().from(imagingDoseSrReceipts);
    expect(rc).toMatchObject({ studyId: a.studyId, outcome: "confirmed" });

    await expect(withTx(db, (tx) => attachUnmatched(tx, fx.radiographer, { unmatchedId, accessionNo: a.accessionNo, reason: "again" })))
      .rejects.toMatchObject({ code: "already_resolved" });
  });

  it("T3: attach refuses a study the room has not sent, one that already holds archive images; reject keeps the row with its reason", async () => {
    const waiting = await onTable(true);
    const done = await acquiredCt();
    await arrive(orthanc({ uid: mintStudyInstanceUid(done.studyId), accession: done.accessionNo, patientId: UHID_A }));
    const stray = await arrive(orthanc({ uid: "1.2.6.1", accession: "PHANTOM", patientId: "QA" }));
    const unmatchedId = (stray as { unmatchedId: string }).unmatchedId;

    await expect(withTx(db, (tx) => attachUnmatched(tx, fx.radiographer, { unmatchedId, accessionNo: waiting.accessionNo, reason: "r" })))
      .rejects.toMatchObject({ code: "not_acquired" });
    await expect(withTx(db, (tx) => attachUnmatched(tx, fx.radiographer, { unmatchedId, accessionNo: done.accessionNo, reason: "r" })))
      .rejects.toMatchObject({ code: "images_already_attached" });
    await expect(withTx(db, (tx) => attachUnmatched(tx, bridge, { unmatchedId, accessionNo: done.accessionNo, reason: "r" })))
      .rejects.toMatchObject({ code: "forbidden" });

    await withTx(db, (tx) => rejectUnmatched(tx, fx.radiographer, { unmatchedId, reason: "Morning QA phantom on CT-1", now: LATER }));
    const [row] = await db.select().from(imagingUnmatchedStudies).where(eq(imagingUnmatchedStudies.id, unmatchedId));
    expect(row).toMatchObject({ status: "rejected", resolutionReason: "Morning QA phantom on CT-1", resolvedBy: fx.radiographer.id });
    const reconciled = await db.select().from(events).where(and(eq(events.name, "imaging.images_reconciled")));
    expect(reconciled.map((e) => (e.payload as { outcome: string }).outcome)).toEqual(["rejected"]);
  });

  /* ═════════════════════ T4 — the viewer book ═════════════════════ */

  it("T4: an OHIF viewer is published only with StudyInstanceUIDs={studyInstanceUid}; the archive block is optional and checked", () => {
    const ok = { viewer_url_template: "https://pacs.hospital.in/ohif/viewer?StudyInstanceUIDs={studyInstanceUid}", enabled: true, viewer: "ohif" };
    expect(pacsSettingsBodySchema.safeParse(ok).success).toBe(true);
    expect(pacsSettingsBodySchema.safeParse({ ...ok, viewer_url_template: "https://pacs.hospital.in/ohif/viewer?AccessionNumber={accessionNo}" }).success).toBe(false);
    expect(pacsSettingsBodySchema.safeParse({ ...ok, archive: { kind: "orthanc", ae_title: "HMIS_PACS", base_url: "https://pacs.hospital.in/orthanc" } }).success).toBe(true);
    expect(pacsSettingsBodySchema.safeParse({ ...ok, archive: { kind: "orthanc", ae_title: "hmis pacs", base_url: "https://x.in" } }).success).toBe(false);
    // A book published before RS12 still parses.
    expect(pacsSettingsBodySchema.safeParse({ viewer_url_template: "https://pacs.x.in/v?a={accessionNo}", enabled: false }).success).toBe(true);
  });

  it("census: `radiology_pacs_configured` is RED (PACS not configured) until a book names the archive, then ok", async () => {
    const verdict = async () => (await runCensus(db, "radiology")).find((r) => r.code === "radiology_pacs_configured")!.verdict;
    expect(await verdict()).toBe("RED");
    await db.insert(imagingDefinitions).values({
      id: newId(), kind: "pacs_settings", version: 1, status: "active",
      body: { viewer_url_template: "https://pacs.x.in/ohif/viewer?StudyInstanceUIDs={studyInstanceUid}", enabled: true, viewer: "ohif" },
      draftedBy: fx.radiologist.id, publishedBy: fx.radiologist.id, publishedAt: NOW,
    });
    expect(await verdict()).toBe("RED"); // a viewer alone is not an archive
    await db.update(imagingDefinitions).set({
      body: { viewer_url_template: "https://pacs.x.in/ohif/viewer?StudyInstanceUIDs={studyInstanceUid}", enabled: true, viewer: "ohif",
        archive: { kind: "orthanc", ae_title: "HMIS_PACS", base_url: "https://pacs.x.in/orthanc" } },
    }).where(eq(imagingDefinitions.kind, "pacs_settings"));
    expect(await verdict()).toBe("ok");
  });
});
