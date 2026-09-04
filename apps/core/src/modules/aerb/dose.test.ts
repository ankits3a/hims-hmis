import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { doseRegister, patients, phiAccessLog, registrationConfig, resources } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { aerbManifest } from "./manifest";
import { doseRegisterRows, patientCumulativeDose, recordDose } from "./dose";
import { DOSE_UNITS } from "./units";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18c T3 — the patient dose register.
 *
 * ═══ WHAT THE ASSERTIONS ARE ABOUT ═══
 *
 * Three things, and none of them is "does it store a number":
 *
 *   · **`null` is not `false`.** An examination nobody has published a reference level for has NOT
 *     passed anything, and a register that recorded `over_drl = false` for it would be reporting a
 *     compliance it never measured.
 *   · **One row per source event.** 18a's acquisition CAS comment names the mutant — "a
 *     double-click double-emits and 18c counts the dose twice" — and the unique index is the half
 *     that holds even if that guard is weakened.
 *   · **It is PHI and logs like PHI.** One row per patient DISCLOSED (18a's F42), and nothing at
 *     all for a reader who was refused.
 */
describe("the patient dose register (18c T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let rso: Actor;
  let radiologist: Actor;
  let outsider: Actor;
  let ct: string;

  const P1 = "01PATIENT0000000000000001";
  const P2 = "01PATIENT0000000000000002";
  const T0 = new Date("2026-06-15T09:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    for (const [id, uhid, name] of [[P1, "HMS-00000001-5", "Asha Devi"], [P2, "HMS-00000002-3", "Ravi Kumar"]]) {
      await db.insert(patients).values({
        id: id!, uhid: uhid!, name: name!, sex: "female", administrativeGender: "female",
        dob: new Date(Date.UTC(1996, 0, 1)), createdBy: "t", updatedBy: "t",
      });
    }
    ct = newId();
    await db.insert(resources).values({
      id: ct, kind: "device", code: "CT-1", name: "CT machine", status: "available",
      attributes: { modality: "ct" }, createdBy: "t", updatedBy: "t",
    });

    const registry = new ModuleRegistry();
    registry.install(aerbManifest);
    await syncPermissions(db, registry);
    for (const role of ["radiation_safety_officer", "radiologist", "radiology_receptionist"]) await ensureRole(db, role);
    for (const p of aerbManifest.permissions) {
      await grantPermissionToRole(db, registry, "radiation_safety_officer", p);
    }
    await grantPermissionToRole(db, registry, "radiologist", "aerb.doses.read");
    ({ actor: rso } = await mkUser(db, "rso.bhat", ["radiation_safety_officer"]));
    ({ actor: radiologist } = await mkUser(db, "dr.rao", ["radiologist"]));
    ({ actor: outsider } = await mkUser(db, "front.desk", ["radiology_receptionist"]));
  });

  const write = (over: Partial<Parameters<typeof recordDose>[2]> = {}) =>
    withTx(db, (tx) => recordDose(tx, rso, {
      source: "imaging", sourceRef: newId(), patientId: P1, deviceResourceId: ct,
      modality: "ct", procedureCode: "CT-HEAD", doseDlp: 950.5, doseManual: false,
      drl: { quantity: "dlp", value: 1000, over: false }, occurredAt: T0, ...over,
    }));

  /* ═════════════ NULL IS NOT FALSE ═════════════ */

  it("stores the comparison as a fact — quantity, level and verdict together", async () => {
    const { doseRecordId } = await write({ doseDlp: 1200, drl: { quantity: "dlp", value: 1000, over: true } });
    const [row] = await db.select().from(doseRegister).where(eq(doseRegister.id, doseRecordId));
    expect(row!.drlQuantity).toBe("dlp");
    expect(row!.drlValue).toBe("1000.000");
    expect(row!.overDrl).toBe(true);
  });

  it("an examination with NO published level stores null — which is not `under`", async () => {
    const { doseRecordId } = await write({ drl: null });
    const [row] = await db.select().from(doseRegister).where(eq(doseRegister.id, doseRecordId));
    expect(row!.overDrl).toBeNull();
    expect(row!.drlValue).toBeNull();
    /** And it is absent from the over-DRL review, which is the query an RSO actually runs. */
    expect(await doseRegisterRows(db, rso, { overDrlOnly: true })).toHaveLength(0);
  });

  it("the CHECK refuses half a comparison — a verdict nobody can check", async () => {
    await expect(db.insert(doseRegister).values({
      id: newId(), source: "imaging", sourceRef: newId(), patientId: P1, modality: "ct",
      procedureCode: "CT-HEAD", doseDlp: "900", overDrl: true, occurredAt: T0, recordedBy: "t",
    })).rejects.toThrow(/radiation_dose_register_drl_ck/);
  });

  it("the CHECK refuses a register row with no number in it at all", async () => {
    await expect(db.insert(doseRegister).values({
      id: newId(), source: "imaging", sourceRef: newId(), patientId: P1, modality: "ct",
      procedureCode: "CT-HEAD", occurredAt: T0, recordedBy: "t",
    })).rejects.toThrow(/radiation_dose_register_dose_ck/);
  });

  /* ═════════════ ONE ROW PER SOURCE EVENT ═════════════ */

  it("refuses a second row for the same source event — the doubled dose 18a named", async () => {
    const ref = newId();
    await write({ sourceRef: ref });
    await expect(write({ sourceRef: ref })).rejects.toThrow(/radiation_dose_register_source_ux/);
  });

  it("the same ref from a DIFFERENT source is a different examination and is allowed", async () => {
    const ref = newId();
    await write({ sourceRef: ref });
    await expect(write({ sourceRef: ref, source: "cath_lab", doseDap: 42.5, doseDlp: null, drl: null }))
      .resolves.toMatchObject({ doseRecordId: expect.any(String) });
  });

  /* ═════════════ IT IS PHI ═════════════ */

  it("logs ONE aerb.dose_register row per patient DISCLOSED, never one per page", async () => {
    await write({ patientId: P1 });
    await write({ patientId: P1, sourceRef: newId(), occurredAt: new Date("2026-06-16T09:00:00.000Z") });
    await write({ patientId: P2, sourceRef: newId() });
    const rows = await doseRegisterRows(db, rso);
    expect(rows).toHaveLength(3);
    const logged = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "aerb.dose_register"));
    expect(logged).toHaveLength(2);
    expect(new Set(logged.map((l) => l.patientId))).toEqual(new Set([P1, P2]));
  });

  it("a reader without aerb.doses.read is refused and logs NOTHING", async () => {
    await write();
    await expect(doseRegisterRows(db, outsider)).rejects.toMatchObject({
      code: "not_appointed", detail: { permission: "aerb.doses.read" },
    });
    expect(await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "aerb.dose_register"))).toHaveLength(0);
  });

  /* ═════════════ THE CUMULATIVE NUDGE (D8 / O4) ═════════════ */

  it("sums the twelve-month window per patient and counts the over-DRL examinations", async () => {
    const now = new Date("2026-06-20T00:00:00.000Z");
    await write({ doseDlp: 900, occurredAt: new Date("2026-01-10T00:00:00.000Z") });
    await write({ sourceRef: newId(), doseDlp: 1100, drl: { quantity: "dlp", value: 1000, over: true }, occurredAt: new Date("2026-03-10T00:00:00.000Z") });
    await write({ sourceRef: newId(), doseDlp: 200, occurredAt: new Date("2026-06-10T00:00:00.000Z") });
    /** Another patient's dose must not land in this patient's total. */
    await write({ sourceRef: newId(), patientId: P2, doseDlp: 5000 });

    const c = await patientCumulativeDose(db, radiologist, P1, { now });
    expect(c.studyCount).toBe(3);
    expect(Number(c.totalDlp)).toBeCloseTo(2200, 3);
    expect(c.overDrlCount).toBe(1);
    expect(c.lastOccurredAt).toBe("2026-06-10T00:00:00.000Z");
  });

  it("an examination older than the window is outside the total", async () => {
    const now = new Date("2026-06-20T00:00:00.000Z");
    await write({ doseDlp: 900, occurredAt: new Date("2025-01-10T00:00:00.000Z") });
    const c = await patientCumulativeDose(db, radiologist, P1, { now });
    expect(c.studyCount).toBe(0);
    expect(c.totalDlp).toBeNull();
  });

  /**
   * O4's ruling in one assertion: *"nudge, not block"*. There is no refusal in this file's write
   * path, and a patient with six CTs behind them still records the seventh.
   */
  it("NEVER refuses on cumulative dose — six CTs in a year do not stop the seventh", async () => {
    const now = new Date("2026-06-20T00:00:00.000Z");
    for (let i = 0; i < 6; i += 1) {
      await write({ sourceRef: newId(), doseDlp: 1500, drl: { quantity: "dlp", value: 1000, over: true },
        occurredAt: new Date(Date.UTC(2026, i, 5)) });
    }
    const before = await patientCumulativeDose(db, radiologist, P1, { now });
    expect(before.studyCount).toBe(6);
    expect(before.overDrlCount).toBe(6);
    await expect(write({ sourceRef: newId(), doseDlp: 1500 })).resolves.toBeDefined();
  });

  /**
   * ═══ CLOSE REVIEW — THE REGISTER WAS MERGE-BLIND ═══
   *
   * `merge` never rewrites another module's rows, so a dose row written before a merge keeps the
   * LOSER's patient id for ever. Keyed on the canonical id alone, the nudge whose entire purpose is
   * O4's *"young patient with six CTs in a year"* reported ONE — and a duplicate registration is
   * the commonest reason an imaging history is split in the first place.
   */
  it("the cumulative follows a merge — the loser's examinations are the survivor's history", async () => {
    const now = new Date("2026-06-20T00:00:00.000Z");
    await write({ patientId: P2, doseDlp: 900, occurredAt: new Date("2026-02-10T00:00:00.000Z") });
    await write({ sourceRef: newId(), patientId: P2, doseDlp: 1100,
      drl: { quantity: "dlp", value: 1000, over: true }, occurredAt: new Date("2026-03-10T00:00:00.000Z") });
    await write({ sourceRef: newId(), patientId: P1, doseDlp: 300, occurredAt: new Date("2026-06-10T00:00:00.000Z") });

    /** Before the merge, each id knows only its own. */
    expect((await patientCumulativeDose(db, radiologist, P1, { now })).studyCount).toBe(1);

    /** P2 is merged INTO P1: `merge_id` on the loser is what `listMergedLoserIds` reads. */
    await db.update(patients).set({ mergedIntoPatientId: P1, status: "merged" }).where(eq(patients.id, P2));

    const after = await patientCumulativeDose(db, radiologist, P1, { now });
    expect(after.studyCount).toBe(3);
    expect(Number(after.totalDlp)).toBeCloseTo(2300, 3);
    expect(after.overDrlCount).toBe(1);
  });

  it("logs NOTHING for a patient with no register rows — an unread chart is not a disclosure", async () => {
    await patientCumulativeDose(db, radiologist, P2, { now: new Date("2026-06-20T00:00:00.000Z") });
    expect(await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "aerb.dose_register"))).toHaveLength(0);
  });

  /* ═════════════ THE UNITS 18b LEFT UNSTATED ═════════════ */

  it("names a unit for every quantity, and DAP is not measured in DLP's unit", () => {
    expect(DOSE_UNITS.ctdivol).toBe("mGy");
    expect(DOSE_UNITS.dlp).toBe("mGy·cm");
    expect(DOSE_UNITS.dap).toBe("Gy·cm²");
    expect(DOSE_UNITS.fluoro_seconds).toBe("s");
    expect(DOSE_UNITS.dap).not.toBe(DOSE_UNITS.dlp);
  });

  /* ═══ CLOSE REVIEW, CRITICAL — A CONFIDENTIAL PATIENT IS ALIASED HERE TOO ═══ */

  /**
   * The register selected `patients.name` raw. Every other patient-bearing surface in this
   * department renders through `displayName`, so a VIP, a staff member or a police case showed
   * their alias on the worklist and their LEGAL NAME on this register — to every holder of
   * `aerb.doses.read`, which includes every radiographer, none of whom holds
   * `patients.confidential.read`.
   */
  it("shows a confidential patient's ALIAS to a reader without clearance", async () => {
    await db.update(patients)
      .set({ isConfidential: true, alias: "Patient A" })
      .where(eq(patients.id, P1));
    await write({ patientId: P1 });

    const rows = await doseRegisterRows(db, rso);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.patientName).toBe("Patient A");
    expect(JSON.stringify(rows)).not.toContain("Asha Devi");
  });

  it("shows the real name to a reader who DOES hold patients.confidential.read", async () => {
    const registry = new ModuleRegistry();
    registry.install(aerbManifest);
    registry.install({
      key: "patients", title: "Patients", menu: [], subscriptions: [],
      permissions: ["patients.confidential.read"],
    });
    await syncPermissions(db, registry);
    await ensureRole(db, "mrd_officer");
    for (const p of [...aerbManifest.permissions, "patients.confidential.read"]) {
      await grantPermissionToRole(db, registry, "mrd_officer", p);
    }
    const { actor: mrd } = await mkUser(db, "mrd.one", ["mrd_officer"]);
    await db.update(patients)
      .set({ isConfidential: true, alias: "Patient A" })
      .where(eq(patients.id, P1));
    await write({ patientId: P1 });
    const rows = await doseRegisterRows(db, mrd);
    expect(rows[0]!.patientName).toBe("Asha Devi");
  });

  it("the book reads newest first and carries the patient's name and UHID for the RSO", async () => {
    await write({ occurredAt: new Date("2026-06-10T00:00:00.000Z") });
    await write({ sourceRef: newId(), patientId: P2, occurredAt: new Date("2026-06-12T00:00:00.000Z") });
    const rows = await doseRegisterRows(db, rso);
    expect(rows.map((r) => r.uhid)).toEqual(["HMS-00000002-3", "HMS-00000001-5"]);
    expect(rows[0]!.patientName).toBe("Ravi Kumar");
    expect(rows[0]!.deviceCode).toBe("CT-1");
  });
});
