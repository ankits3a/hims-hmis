import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  placeAndCreateStudy, setupRadiologyFixture, startStudyOnMachine, studyTypeRow,
} from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { approveRequest } from "../../kernel/approvals/decisions";
import {
  doseRegister, events, imagingBillDecisions, imagingDefinitions, imagingStudies, opdEncounters, opdVitals,
} from "../../kernel/db/schema";
import { addAllergy } from "../patients";
import {
  activeDefinition, draftDefinition, imagingProtocolsBodySchema, parseDefinitionBody, protocolFor,
  publishDefinition, requestDefinitionPublish,
} from "./definitions";
import { recordAcquired, recordRepeatExposure, startAcquisition } from "./acquisition";
import { checkIn } from "./checkin";
import { registerRadiologyApprovalTypes } from "./approval-types";
import { evaluateReadiness, requireStudyGate, satisfyGate } from "./gates";
import { scheduleStudy } from "./schedule";
import { roomRejects, roomView } from "./room";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS6 — the modality rooms' core: the `imaging_protocols` book (T1), the console's read,
 * the in-room repeat, and the two reasons the console now carries (above-DRL, contrast not given).
 */
describe("modality rooms (18-S RS6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date(`${DAY}T06:00:00.000Z`);
  const SLOT = new Date(`${DAY}T09:00:00.000Z`);

  const CT_PROTOCOL = {
    study_type_code: "CT-HEAD", name: "CT brain, plain", technique: "Axial from skull base to vertex; tilt parallel to OM line.",
    kv: { min: 100, max: 120 }, mas: { min: 250, max: 300 }, ct: { slice_mm: 5, pitch: 0.9 },
    breath_hold: { en: "Keep your head still.", hi: "सिर बिल्कुल स्थिर रखें।" },
  };
  const CT_DEFAULT = {
    modality: "ct", name: "CT default", technique: "Department CT default.",
    contrast: { phase: "portal_venous", ml_per_kg: 1.5, max_ml: 100, delay_s: 70 },
  };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
  });
  afterEach(() => { fx.unregister(); });

  /* ═════════════════════ T1 — the protocol book, governed ═════════════════════ */

  it("T1: an imaging_protocols book drafts, is approved by the MS, publishes and becomes the active book", async () => {
    const { actor: ms } = await mkUser(db, "ms.two", ["medical_superintendent"]);
    const { actor: owner } = await mkUser(db, "owner.two", ["owner"]);
    await registerRadiologyApprovalTypes(db, owner);
    const d = await withTx(db, async (tx) => {
      const drafted = await draftDefinition(tx, fx.radiologist, { kind: "imaging_protocols", body: { protocols: [CT_PROTOCOL, CT_DEFAULT] } });
      const { approvalId } = await requestDefinitionPublish(tx, fx.radiologist, drafted.definitionId);
      return { ...drafted, approvalId };
    });
    await approveRequest(db, ms, { approvalId: d.approvalId, note: "protocols reviewed" });
    await publishDefinition(db, ms, { definitionId: d.definitionId, approvalId: d.approvalId });
    const book = await activeDefinition(db, "imaging_protocols");
    expect(book.protocols.map((p) => p.name)).toEqual(["CT brain, plain", "CT default"]);
  });

  it("T1: the database CHECK admits the new kind (the migration widened imaging_definitions_kind_ck)", async () => {
    await expect(db.insert(imagingDefinitions).values({
      id: newId(), kind: "imaging_protocols", version: 1, body: { protocols: [CT_PROTOCOL] },
      status: "draft", draftedBy: fx.radiologist.id,
    })).resolves.toBeDefined();
  });

  it("T1: a malformed book is refused at draft — no key, duplicate key, inverted range, half a script, a bad band", async () => {
    const bad = [
      { protocols: [{ name: "x", technique: "y" }] },
      { protocols: [CT_PROTOCOL, { ...CT_PROTOCOL, name: "again" }] },
      { protocols: [{ ...CT_PROTOCOL, kv: { min: 140, max: 80 } }] },
      { protocols: [{ ...CT_PROTOCOL, breath_hold: { en: "Breathe in." } }] },
      { protocols: [{ ...CT_PROTOCOL, paediatric: { bands: [{ from_kg: 20, to_kg: 10 }] } }] },
      { protocols: [{ ...CT_DEFAULT, contrast: { phase: "arterial", ml_per_kg: 9, max_ml: 100, delay_s: 30 } }] },
      { protocols: [] },
    ];
    for (const body of bad) {
      await expect(withTx(db, (tx) => draftDefinition(tx, fx.radiologist, { kind: "imaging_protocols", body })))
        .rejects.toMatchObject({ code: "definition_invalid" });
    }
    expect(imagingProtocolsBodySchema.safeParse({ protocols: [CT_PROTOCOL, CT_DEFAULT] }).success).toBe(true);
  });

  it("T1: the study type's own protocol wins; the modality default covers the rest; nothing matches → null", () => {
    const body = parseDefinitionBody("imaging_protocols", { protocols: [CT_DEFAULT, CT_PROTOCOL] });
    expect(protocolFor(body, "CT-HEAD", "ct")).toMatchObject({ matchedOn: "study_type", protocol: { name: "CT brain, plain" } });
    expect(protocolFor(body, "CT-CHEST", "ct")).toMatchObject({ matchedOn: "modality", protocol: { name: "CT default" } });
    expect(protocolFor(body, "XR-CHEST", "xray")).toBeNull();
  });

  /* ═════════════════════ the console's read ═════════════════════ */

  const publishBook = async (kind: "imaging_protocols" | "dose_reference_levels", body: unknown) => {
    await db.insert(imagingDefinitions).values({
      id: newId(), kind, version: 1, body: body as object, status: "active",
      draftedBy: fx.radiologist.id, publishedBy: fx.radiologist.id, publishedAt: NOW,
    });
  };

  it("room read: no book says `none`; a published book answers the study's protocol, with DRL, allergies and weight", async () => {
    const study = await placeAndCreateStudy(db, fx, "CT-HEAD", "r1", NOW);
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.ct!, scheduledAt: SLOT,
    }));
    const before = await roomView(db, fx.radiographer, study.studyId, NOW);
    expect(before.protocol).toEqual({ book: "none", version: null, matchedOn: null, protocol: null });
    expect(before.patient.weight).toBeNull();

    await publishBook("imaging_protocols", { protocols: [CT_PROTOCOL] });
    await publishBook("dose_reference_levels", { levels: [
      { study_type_code: "CT-HEAD", quantity: "dlp", value: 1000 },
      { modality: "ct", quantity: "ctdivol", value: 60 },
    ] });
    await withTx(db, (tx) => addAllergy(tx, fx.doctor, fx.patientId, {
      substance: "Iohexol", reaction: "urticaria", severity: "mild", source: "consult",
    }));
    const [enc] = await db.select().from(opdEncounters);
    await db.insert(opdVitals).values({
      id: newId(), encounterId: enc!.id, patientId: fx.patientId, weightKg: 58, band: "adult",
      dangerFlags: [], recordedBy: "t",
    } as never);

    const v = await roomView(db, fx.radiographer, study.studyId, NOW);
    expect(v.protocol).toMatchObject({ book: "active", version: 1, matchedOn: "study_type", protocol: { name: "CT brain, plain" } });
    expect(v.drl).toEqual([{ study_type_code: "CT-HEAD", quantity: "dlp", value: 1000 }]);
    expect(v.patient.allergies).toEqual(["Iohexol"]);
    expect(v.patient.weight?.kg).toBe(58);
    expect(v.patient.ageYears).toBe(30);
    expect(v.device?.code).toBe("DEV-CT");
    expect([v.modality, v.ionising, v.contrastOption]).toEqual(["ct", true, "none"]);
  });

  /* ═════════════════════ the in-room repeat ═════════════════════ */

  it("repeat: refused before the patient is on the machine", async () => {
    const study = await placeAndCreateStudy(db, fx, "XR-CHEST", "p1", NOW);
    await expect(withTx(db, (tx) => recordRepeatExposure(tx, fx.radiographer, { studyId: study.studyId, reason: "positioning" })))
      .rejects.toMatchObject({ code: "bad_transition" });
  });

  it("repeat: each retake is an event with its reason; ONE repeat_no_charge per study; the rejects view counts them", async () => {
    const study = await startStudyOnMachine(db, fx, { serviceCode: "XR-CHEST", deviceKey: "xray", idemKey: "x1", now: NOW, slot: SLOT });
    const first = await withTx(db, (tx) => recordRepeatExposure(tx, fx.radiographer, { studyId: study.studyId, reason: "positioning", now: NOW }));
    const second = await withTx(db, (tx) => recordRepeatExposure(tx, fx.radiographer, { studyId: study.studyId, reason: "motion", now: NOW }));
    expect(first.billDecisionId).not.toBeNull();
    expect(second.billDecisionId).toBeNull();

    const decisions = await db.select().from(imagingBillDecisions).where(eq(imagingBillDecisions.studyId, study.studyId));
    expect(decisions.map((d) => [d.kind, (d.detail as { reason: string }).reason])).toEqual([["repeat_no_charge", "positioning"]]);
    const evs = (await db.select().from(events)).filter((e) => e.name === "imaging.exposure_repeated");
    expect(evs.map((e) => (e.payload as { reason: string }).reason).sort()).toEqual(["motion", "positioning"]);

    await withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, {
      studyId: study.studyId, imageSource: "no_pacs_images", doseDap: 0.12, now: NOW,
    }));
    const today = new Date().toISOString().slice(0, 10);
    const view = await roomRejects(db, { from: "2020-01-01", to: today });
    expect(view.rows).toEqual([expect.objectContaining({ deviceCode: "DEV-XRAY", acquired: 1, repeats: 2 })]);
    expect(view.reasons).toEqual([{ reason: "positioning", count: 1 }, { reason: "motion", count: 1 }]);
    expect(view.log).toHaveLength(2);
    expect(view.openDecisions.map((d) => [d.kind, d.accessionNo, d.reason])).toEqual([["repeat_no_charge", study.accessionNo, "positioning"]]);

    const room = await roomView(db, fx.radiographer, study.studyId, NOW);
    expect(room.repeats.map((r) => r.reason).sort()).toEqual(["motion", "positioning"]);
  });

  /* ═════════════════════ the two reasons the console carries ═════════════════════ */

  it("DRL: an over-DRL examination keeps the technologist's reason; an under-DRL one keeps none", async () => {
    await publishBook("dose_reference_levels", { levels: [{ study_type_code: "XR-CHEST", quantity: "dap", value: 0.2 }] });
    const over = await startStudyOnMachine(db, fx, { serviceCode: "XR-CHEST", deviceKey: "xray", idemKey: "d1", now: NOW, slot: SLOT });
    await withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, {
      studyId: over.studyId, imageSource: "no_pacs_images", doseDap: 0.35, drlReason: "Obese patient, 118 kg", now: NOW,
    }));
    const under = await startStudyOnMachine(db, fx, { serviceCode: "XR-CHEST", deviceKey: "xray", idemKey: "d2", now: new Date(NOW.getTime() + 26 * 3_600_000), slot: new Date(SLOT.getTime() + 3_600_000) });
    await withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, {
      studyId: under.studyId, imageSource: "no_pacs_images", doseDap: 0.1, drlReason: "typed anyway", now: NOW,
    }));
    const [o] = await db.select().from(doseRegister).where(eq(doseRegister.sourceRef, over.studyId));
    const [u] = await db.select().from(doseRegister).where(eq(doseRegister.sourceRef, under.studyId));
    expect([o!.overDrl, o!.drlReason]).toEqual([true, "Obese patient, 118 kg"]);
    expect([u!.overDrl, u!.drlReason]).toEqual([false, null]);
    await expect(db.update(doseRegister).set({ drlReason: "x" }).where(eq(doseRegister.id, u!.id)))
      .rejects.toThrow(/radiation_dose_register_drl_reason_ck/);
  });

  it("contrast not given: the console's reason rides the contrast_not_given bill decision", async () => {
    fx.unregister();
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    const [bookRow] = await db.select().from(imagingDefinitions).where(eq(imagingDefinitions.kind, "study_types"));
    const types = (bookRow!.body as { types: ReturnType<typeof studyTypeRow>[] }).types
      .map((t) => (t.code === "CT-HEAD" ? { ...t, contrast_option: "required" as const } : t));
    await db.update(imagingDefinitions).set({ body: { types } }).where(eq(imagingDefinitions.id, bookRow!.id));

    const study = await placeAndCreateStudy(db, fx, "CT-HEAD", "c1", NOW);
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId: study.studyId, deviceResourceId: fx.devices.ct!, scheduledAt: SLOT }));
    const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    const evidence: Record<string, unknown> = {
      identity_two_factor: { secondIdentifier: "uhid", value: "HMS-00000001-5" },
      pregnancy_screen: { declared: true, lmpDate: new Date(NOW.getTime() - 10 * 86_400_000).toISOString() },
      contrast_consent: {
        procedureCode: "CT-HEAD", templateVersion: "rad-contrast-v3", language: "hi", signer: "patient",
        conversionCovered: false, laterality: null, signedAt: NOW.toISOString(),
      },
      renal_function: { creatinineUmolL: 72, sampledAt: NOW.toISOString(), source: "internal" },
      prior_contrast_reaction: {},
    };
    for (const kind of checked.gates) {
      const gate = await requireStudyGate(db, study.studyId, kind);
      await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidence[kind] ?? {}, NOW));
    }
    await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await withTx(db, (tx) => startAcquisition(tx, fx.radiographer, fx.decls, { studyId: study.studyId, now: NOW }));

    const room = await roomView(db, fx.radiographer, study.studyId, NOW);
    expect(room.renal).toEqual({ creatinineUmolL: 72, egfr: null, sampledAt: NOW.toISOString() });

    await withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, {
      studyId: study.studyId, imageSource: "no_pacs_images", doseDlp: 900, contrastGiven: false,
      contrastNotGivenReason: "Cannula tissued; scanned plain", now: NOW,
    }));
    const decisions = await db.select().from(imagingBillDecisions)
      .where(eq(imagingBillDecisions.studyId, study.studyId));
    const d = decisions.find((x) => x.kind === "contrast_not_given");
    expect((d?.detail as { reason?: string } | undefined)?.reason).toBe("Cannula tissued; scanned plain");
  });
});
