import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture, studyTypeRow } from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import {
  imagingDefinitions, labAnalytes, labResults, orderItems, orders, patients, services,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { latestVerifiedCreatinine } from "../lab";
import { registerRadiologyApprovalTypes } from "./approval-types";
import { checkIn } from "./checkin";
import { requireStudyGate, satisfyGate } from "./gates";
import { requestGateOverride } from "./override-requests";
import { prepBayList, prepStudyView } from "./prep-bay";
import { scheduleStudy } from "./schedule";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS5 T3 — the prep bay's reads: which studies are the bay's (an open PREP gate; the
 * console's identity and side do not count), and what the patient in hand shows — the lab's latest
 * signed creatinine with the same eGFR the gate computes.
 */
describe("the prep & safety bay reads (18-S RS5 T3)", () => {
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
    await db.update(imagingDefinitions).set({ body: { types: [
      studyTypeRow({ code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg" }),
      studyTypeRow({ code: "XR-CHEST", service_id: fx.services["XR-CHEST"]!, modality: "xray", laterality_applicable: true }),
      studyTypeRow({ code: "CT-HEAD", service_id: fx.services["CT-HEAD"]!, modality: "ct", contrast_option: "required" }),
      studyTypeRow({ code: "MRI-BRAIN", service_id: fx.services["MRI-BRAIN"]!, modality: "mri" }),
    ] } }).where(eq(imagingDefinitions.kind, "study_types"));
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  const arrive = async (serviceCode: string, deviceKey: string) => {
    seq += 1;
    const study = await placeAndCreateStudy(
      db, fx, serviceCode, `prep${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000),
    );
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices[deviceKey]!,
      scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    return study;
  };

  /** A signed serum creatinine on the lab's own rows (CREA, mg/dL), drawn `daysAgo`. */
  const labCreatinine = async (mgDl: string, verifiedAt: Date, status = "verified") => {
    const svc = newId();
    await db.insert(services).values({ id: svc, code: `LAB-${svc.slice(-6)}`, name: "Creatinine", category: "investigation", createdBy: "t", updatedBy: "t" });
    const existing = await db.select().from(labAnalytes).where(eq(labAnalytes.code, "CREA"));
    const analyteId = existing[0]?.id ?? newId();
    if (!existing[0]) {
      await db.insert(labAnalytes).values({ id: analyteId, code: "CREA", nameEn: "Creatinine", resultType: "numeric", unit: "mg/dL", createdBy: "t", updatedBy: "t" });
    }
    const orderId = newId();
    await db.insert(orders).values({
      id: orderId, orderNo: `L${orderId.slice(-8)}`, orderGroupId: orderId, kind: "lab", patientId: fx.patientId,
      encounterNo: fx.visitNo, serviceDate: DAY, priority: "routine", authority: "clinician",
      orderedByType: "user", orderedById: fx.doctor.id, placedAt: verifiedAt,
    });
    const itemId = newId();
    await db.insert(orderItems).values({ id: itemId, orderId, serviceId: svc });
    const resultId = newId();
    await db.insert(labResults).values({
      id: resultId, orderItemId: itemId, analyteId, valueNumeric: mgDl, unit: "mg/dL",
      enteredByType: "user", enteredById: "t", entryMode: "manual",
      verificationStatus: status, verifiedBy: status === "verified" ? "path" : null,
      verifiedAt: status === "verified" ? verifiedAt : null,
    });
    return resultId;
  };

  it("lists a checked-in study while a PREP gate is open, with the room gates apart; not once only room gates remain", async () => {
    const ct = await arrive("CT-HEAD", "ct");
    const xr = await arrive("XR-CHEST", "xray");
    const rows = await prepBayList(db, nurse);
    const byId = new Map(rows.map((r) => [r.studyId, r]));
    expect(byId.get(ct.studyId)).toMatchObject({
      openPrep: ["contrast_consent", "prior_contrast_reaction", "renal_function"],
      openRoom: ["identity_two_factor"], asked: [],
    });
    /** The X-ray opens only identity and side — both the console's — so it is NOT the bay's. */
    expect(byId.has(xr.studyId)).toBe(false);
  });

  it("marks a prep gate the radiologist has been asked about", async () => {
    const ct = await arrive("CT-HEAD", "ct");
    await withTx(db, (tx) => requestGateOverride(tx, nurse, { studyId: ct.studyId, kind: "renal_function", note: "eGFR 25" }));
    const [row] = await prepBayList(db, nurse);
    expect(row!.asked).toEqual(["renal_function"]);
  });

  it("the study leaves the list when its last prep gate closes", async () => {
    const ct = await arrive("CT-HEAD", "ct");
    const gate = async (kind: string) => (await requireStudyGate(db, ct.studyId, kind)).id;
    await withTx(db, async (tx) => satisfyGate(tx, nurse, await gate("prior_contrast_reaction"), {}, NOW));
    await withTx(db, async (tx) => satisfyGate(tx, nurse, await gate("renal_function"), {
      creatinineUmolL: 70, sampledAt: NOW.toISOString(), source: "internal",
    }, NOW));
    expect((await prepBayList(db, nurse)).map((r) => r.studyId)).toEqual([ct.studyId]);
    await withTx(db, async (tx) => satisfyGate(tx, nurse, await gate("contrast_consent"), {
      procedureCode: "CT-HEAD", templateVersion: "rad-contrast-v1", language: "hi", signer: "patient",
      witness: "Rekha", conversionCovered: false, signedAt: NOW.toISOString(),
    }, NOW));
    expect(await prepBayList(db, nurse)).toEqual([]);
  });

  it("the patient in hand carries the lab's latest SIGNED creatinine and the gate's own eGFR", async () => {
    await db.update(patients).set({ dob: new Date(Date.UTC(1966, 0, 1)) }).where(eq(patients.id, fx.patientId));
    await labCreatinine("1.40", new Date(NOW.getTime() - 5 * 86_400_000));
    const latest = await labCreatinine("1.00", new Date(NOW.getTime() - 2 * 86_400_000));
    await labCreatinine("3.00", new Date(NOW.getTime() - 86_400_000), "unverified");
    const ct = await arrive("CT-HEAD", "ct");
    const view = await prepStudyView(db, nurse, ct.studyId, NOW);
    expect(view.kidney.creatinine).toMatchObject({ resultId: latest, umolL: 88.42 });
    /** 60-year-old woman, 1.0 mg/dL → the NKF's own example, 64. */
    expect(view.kidney.egfr).toMatchObject({ computed: true, egfr: 64, band: "clear" });
    expect(view.gates.find((g) => g.kind === "identity_two_factor")).toMatchObject({ room: true, neverWaive: true });
    expect(view.gates.find((g) => g.kind === "renal_function")).toMatchObject({ room: false, waivable: false, neverOverride: false });
    expect(view.staff.map((s) => s.name)).toEqual(expect.arrayContaining(["dr.rao", "rn.kaur", "rt.singh"]));

    /** And the gate takes the lab's value by POINTER — the typed pair is ignored. */
    const gateId = (await requireStudyGate(db, ct.studyId, "renal_function")).id;
    await withTx(db, (tx) => satisfyGate(tx, nurse, gateId, {
      labResultId: latest, creatinineUmolL: 1, sampledAt: NOW.toISOString(), source: "external",
    }, NOW));
    const v2 = await prepStudyView(db, nurse, ct.studyId, NOW);
    expect(v2.gates.find((g) => g.kind === "renal_function")!.evidence).toMatchObject({
      labResultId: latest, creatinineUmolL: 88.42, source: "internal", egfr: 64,
    });
  });

  it("a pointer at a creatinine that is not the latest signed one is refused", async () => {
    const older = await labCreatinine("1.40", new Date(NOW.getTime() - 5 * 86_400_000));
    await labCreatinine("1.00", new Date(NOW.getTime() - 2 * 86_400_000));
    expect((await latestVerifiedCreatinine(db, fx.patientId))!.resultId).not.toBe(older);
    const ct = await arrive("CT-HEAD", "ct");
    const gateId = (await requireStudyGate(db, ct.studyId, "renal_function")).id;
    await expect(withTx(db, (tx) => satisfyGate(tx, nurse, gateId, {
      labResultId: older, creatinineUmolL: 100, sampledAt: NOW.toISOString(), source: "internal",
    }, NOW))).rejects.toMatchObject({ code: "evidence_invalid" });
  });
});
