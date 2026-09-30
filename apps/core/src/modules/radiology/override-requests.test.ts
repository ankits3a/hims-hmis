import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture, studyTypeRow } from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import { approvals, imagingDefinitions, imagingSafetyScreenings, patients } from "../../kernel/db/schema";
import { approveRequest } from "../../kernel/approvals/decisions";
import { withTx } from "../../kernel/db/client";
import { registerRadiologyApprovalTypes } from "./approval-types";
import { checkIn } from "./checkin";
import { gateState, overrideGate, requireStudyGate, satisfyGate, studyState } from "./gates";
import { decideGateOverride, gateOverrideRequests, requestGateOverride } from "./override-requests";
import { scheduleStudy } from "./schedule";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { StudyType } from "./definitions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS5 T2 — "Ask the radiologist to override", on the kernel approvals spine.
 *
 * The prep nurse satisfies with evidence and may not override (the engine's plane refuses her);
 * she ASKS, the radiologist decides, and a grant runs the EXISTING `overrideGate` with the decision
 * note as the reason. The never-override kinds refuse the request itself.
 */
describe("the prep bay's override request (18-S RS5 T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let nurse: Actor;
  let seq = 0;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    ({ actor: nurse } = await mkUser(db, "rn.kaur", ["radiology_nurse"]));
    const { actor: activator } = await mkUser(db, "owner.two", ["owner"]);
    await registerRadiologyApprovalTypes(db, activator);
    /** An 80-year-old woman, so a creatinine under the ceiling can still be an eGFR under 30. */
    await db.update(patients).set({ dob: new Date(Date.UTC(1946, 0, 1)) }).where(eq(patients.id, fx.patientId));
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  const book = async (over: Partial<Record<string, Partial<StudyType>>>) => {
    const row = (code: string, base: Partial<StudyType>) =>
      studyTypeRow({ code, service_id: fx.services[code]!, ...base, ...(over[code] ?? {}) });
    await db.update(imagingDefinitions).set({ body: { types: [
      row("USG-ABDO", { modality: "usg" }),
      row("XR-CHEST", { modality: "xray", ionising: true }),
      row("CT-HEAD", { modality: "ct", ionising: true, contrast_option: "required" }),
      row("MRI-BRAIN", { modality: "mri" }),
    ] } }).where(eq(imagingDefinitions.kind, "study_types"));
  };

  const arrive = async (serviceCode: string, deviceKey: string) => {
    seq += 1;
    const study = await placeAndCreateStudy(
      db, fx, serviceCode, `ovr${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000),
    );
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices[deviceKey]!,
      scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    return study.studyId;
  };
  const ask = (studyId: string, kind: string, note: string, actor = nurse) =>
    withTx(db, (tx) => requestGateOverride(tx, actor, { studyId, kind, note }));
  const gateId = async (studyId: string, kind: string) => (await requireStudyGate(db, studyId, kind)).id;

  it("the nurse satisfies a prep gate with evidence — `radiology_nurse` is on the engine's satisfy edge", async () => {
    await book({});
    const studyId = await arrive("CT-HEAD", "ct");
    const r = await withTx(db, async (tx) => satisfyGate(tx, nurse, await gateId(studyId, "prior_contrast_reaction"), {}, NOW));
    expect(r.state).toBe("satisfied");
  });

  it("the nurse cannot override — the engine refuses her on the plane it reads", async () => {
    await book({});
    const studyId = await arrive("CT-HEAD", "ct");
    const id = await gateId(studyId, "renal_function");
    await expect(withTx(db, (tx) => overrideGate(tx, nurse, id, "please")))
      .rejects.toMatchObject({ code: "role_denied" });
    expect(await gateState(db, id)).toBe("open");
  });

  it("asking files ONE pending approval routed to the radiologist; a second ask is refused", async () => {
    await book({});
    const studyId = await arrive("CT-HEAD", "ct");
    const { approvalId } = await ask(studyId, "renal_function", "eGFR 28, suspected bleed — go ahead with hydration?");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row).toMatchObject({
      typeKey: "imaging_gate_override", approverRole: "radiologist", status: "pending",
      subjectType: "imaging_gate", subjectId: await gateId(studyId, "renal_function"),
      requesterId: nurse.id, patientId: fx.patientId,
    });
    await expect(ask(studyId, "renal_function", "again")).rejects.toMatchObject({ code: "override_already_requested" });
    const queue = await gateOverrideRequests(db, fx.radiologist);
    expect(queue.map((q) => [q.kind, q.accessionNo.length > 0, q.requesterName])).toEqual([["renal_function", true, "rn.kaur"]]);
  });

  it("the never-override kinds refuse the REQUEST itself — form_f and laterality_confirm — and file nothing", async () => {
    await book({
      "USG-ABDO": { pcpndt_applicable: true },
      "XR-CHEST": { laterality_applicable: true },
    });
    const usg = await arrive("USG-ABDO", "usg");
    const xr = await arrive("XR-CHEST", "xray");
    await expect(ask(usg, "form_f", "the sonologist is away")).rejects.toMatchObject({ code: "gate_not_overridable" });
    await expect(ask(xr, "laterality_confirm", "patient unsure")).rejects.toMatchObject({ code: "gate_not_overridable" });
    expect(await db.select().from(approvals)).toEqual([]);
  });

  it("a blank note is refused — the radiologist decides from what the bay writes", async () => {
    await book({});
    const studyId = await arrive("CT-HEAD", "ct");
    await expect(ask(studyId, "renal_function", "   ")).rejects.toMatchObject({ code: "reason_required" });
  });

  it("GRANT runs the existing override with the radiologist's reason; the approval is granted", async () => {
    await book({});
    const studyId = await arrive("CT-HEAD", "ct");
    const id = await gateId(studyId, "renal_function");
    const { approvalId } = await ask(studyId, "renal_function", "eGFR 28");
    const out = await decideGateOverride(db, fx.radiologist, {
      approvalId, verdict: "grant", reason: "haemorrhage suspected; hydrate, iso-osmolar agent",
    });
    expect(out).toMatchObject({ verdict: "granted", override: { state: "overridden", kind: "renal_function" } });
    expect(await gateState(db, id)).toBe("overridden");
    const [gate] = await db.select().from(imagingSafetyScreenings).where(eq(imagingSafetyScreenings.id, id));
    expect(gate!.override).toEqual({ actorId: fx.radiologist.id, reason: "haemorrhage suspected; hydrate, iso-osmolar agent" });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row).toMatchObject({ status: "granted", decidedBy: fx.radiologist.id });
    expect(await gateOverrideRequests(db, fx.radiologist)).toEqual([]);
  });

  it("REFUSE rejects the approval and leaves the gate open", async () => {
    await book({});
    const studyId = await arrive("CT-HEAD", "ct");
    const id = await gateId(studyId, "renal_function");
    const { approvalId } = await ask(studyId, "renal_function", "eGFR 28");
    const out = await decideGateOverride(db, fx.radiologist, { approvalId, verdict: "refuse", reason: "do a plain CT" });
    expect(out.verdict).toBe("rejected");
    expect(await gateState(db, id)).toBe("open");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row!.status).toBe("rejected");
  });

  it("a grant made in the kernel's /approvals inbox is APPLIED by the radiology decision", async () => {
    await book({});
    const studyId = await arrive("CT-HEAD", "ct");
    const id = await gateId(studyId, "renal_function");
    const { approvalId } = await ask(studyId, "renal_function", "eGFR 28");
    await approveRequest(db, fx.radiologist, { approvalId, note: "go ahead" });
    expect(await gateState(db, id)).toBe("open");
    const out = await decideGateOverride(db, fx.radiologist, { approvalId, verdict: "grant", reason: "go ahead, hydrate" });
    expect(out.override).toMatchObject({ state: "overridden" });
  });

  it("the nurse cannot decide her own request (the radiologist's permission and role), and the last gate makes the study ready", async () => {
    await book({});
    const studyId = await arrive("CT-HEAD", "ct");
    // Everything but the kidney gate, by the nurse and the technologist.
    await withTx(db, async (tx) => satisfyGate(tx, fx.radiographer, await gateId(studyId, "identity_two_factor"),
      { secondIdentifier: "uhid", value: "HMS-00000001-5" }, NOW));
    await withTx(db, async (tx) => satisfyGate(tx, nurse, await gateId(studyId, "prior_contrast_reaction"), {}, NOW));
    await withTx(db, async (tx) => satisfyGate(tx, nurse, await gateId(studyId, "contrast_consent"), {
      procedureCode: "CT-HEAD", templateVersion: "rad-contrast-v1", language: "hi", signer: "patient",
      witness: "rn.kaur", conversionCovered: false, signedAt: NOW.toISOString(),
    }, NOW));
    const { approvalId } = await ask(studyId, "renal_function", "eGFR 28");
    await expect(decideGateOverride(db, nurse, { approvalId, verdict: "grant", reason: "self-approve" }))
      .rejects.toBeDefined();
    expect(await studyState(db, studyId)).toBe("checked_in");
    const out = await decideGateOverride(db, fx.radiologist, { approvalId, verdict: "grant", reason: "benefit outweighs risk" });
    expect(out.study).toEqual({ state: "ready", open: [] });
  });
});
