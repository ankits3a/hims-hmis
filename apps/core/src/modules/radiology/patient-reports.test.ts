import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { orderItems, orders, phiAccessLog } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ordersManifest } from "../../kernel/orders/manifest";
import { patientReportsForDoctor } from "./patient-reports";
import { amendReport, draftReport, signReport } from "./reports";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * CONSULT V2 — the radiology half of the brief (`patientReportsForDoctor`): SIGNED reports only,
 * the kernel's restricted rule, one PHI row per read. Studies are walked to `acquired` through the
 * real path (`acquireStudy`) and reported through the real `draftReport` / `signReport`.
 */
describe("patientReportsForDoctor — the brief's imaging reports", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const READ_AT = new Date(NOW.getTime() + 30 * 86_400_000);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  let seq = 0;
  const acquired = async (serviceCode = "USG-ABDO", deviceKey = "usg") => {
    seq += 1;
    const at = new Date(NOW.getTime() + seq * 25 * 3_600_000);
    const study = await acquireStudy(db, fx, {
      idemKey: `pr${String(seq)}`, now: at, slot: new Date(SLOT.getTime() + seq * 3_600_000), serviceCode, deviceKey,
    });
    return { ...study, at };
  };
  const draft = (studyId: string, impression: string) =>
    withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId, body: { findings: "Findings.", technique: "Standard." }, impression,
    }));
  const sign = (studyId: string, reportId: string, at: Date) =>
    withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId, reportId, secondFactorAt: new Date(at.getTime() - 60_000), now: at,
    }));
  const signedStudy = async (serviceCode: string, deviceKey: string, impression: string) => {
    const study = await acquired(serviceCode, deviceKey);
    const { reportId } = await draft(study.studyId, impression);
    await sign(study.studyId, reportId, study.at);
    return study;
  };

  it("returns signed reports newest first, with the brief's fields", async () => {
    const first = await signedStudy("USG-ABDO", "usg", "Fatty liver, grade I.");
    const second = await signedStudy("USG-ABDO", "usg", "Liver normal on follow-up.");

    const rows = await patientReportsForDoctor(db, fx.doctor, fx.patientId, READ_AT);
    expect(rows).toEqual([
      { studyName: "Imaging USG-ABDO", impression: "Liver normal on follow-up.", criticalCategory: null, signedAt: second.at.toISOString() },
      { studyName: "Imaging USG-ABDO", impression: "Fatty liver, grade I.", criticalCategory: null, signedAt: first.at.toISOString() },
    ]);
  });

  it("a drafted, unsigned report never reaches the brief, and an amended one reads as its current text", async () => {
    const amended = await signedStudy("USG-ABDO", "usg", "Signed one.");
    const pending = await acquired("USG-ABDO", "usg");
    await draft(pending.studyId, "Draft only.");

    const rows = await patientReportsForDoctor(db, fx.doctor, fx.patientId, READ_AT);
    expect(rows.map((r) => r.impression)).toEqual(["Signed one."]);

    /**
     * The superseded v1 keeps its `signed_at`, so only `status = 'signed'` holds it back — the
     * draft above is already excluded by its null `signed_at` and cannot pin that filter alone.
     */
    const later = new Date(amended.at.getTime() + 3_600_000);
    await withTx(db, (tx) => amendReport(tx, fx.radiologist, {
      studyId: amended.studyId, secondFactorAt: new Date(later.getTime() - 60_000), now: later,
      reason: "calculus missed on the first read", body: { findings: "7 mm calculus." }, impression: "Left renal calculus.",
    }));
    const after = await patientReportsForDoctor(db, fx.doctor, fx.patientId, READ_AT);
    expect(after.map((r) => r.impression)).toEqual(["Left renal calculus."]);
  });

  it("a restricted study is omitted for an unrelated doctor, shown to its ordering clinician and to a restricted-read holder", async () => {
    const study = await signedStudy("USG-ABDO", "usg", "Restricted finding.");
    const orderer = await mkUser(db, "dr.orderer", ["doctor"]);
    /**
     * Written directly, with the reason: `placeAndCreateStudy` places with a free-text
     * `orderingClinicianId` ("dr-consultant") that is no login, and a restricted imaging item needs
     * a PCPNDT-class catalogue row. The reader only reads these two columns; everything else is real.
     */
    await db.update(orders).set({ orderingClinicianId: orderer.id }).where(eq(orders.id, study.orderId));
    await db.update(orderItems).set({ restricted: true }).where(eq(orderItems.id, study.itemId));

    expect(await patientReportsForDoctor(db, fx.doctor, fx.patientId, READ_AT)).toEqual([]);
    expect(await patientReportsForDoctor(db, orderer.actor, fx.patientId, READ_AT)).toHaveLength(1);

    const registry = new ModuleRegistry();
    registry.install(ordersManifest);
    await syncPermissions(db, registry);
    const holder = await mkUser(db, "dr.restricted", ["restricted_reader"]);
    await grantPermissionToRole(db, registry, "restricted_reader", "orders.read.restricted");
    expect(await patientReportsForDoctor(db, holder.actor, fx.patientId, READ_AT)).toHaveLength(1);
  });

  it("writes one PHI access row under imaging.patient_reports", async () => {
    await patientReportsForDoctor(db, fx.doctor, fx.patientId, READ_AT);
    const logged = await db.select().from(phiAccessLog).where(and(
      eq(phiAccessLog.surface, "imaging.patient_reports"), eq(phiAccessLog.actorId, fx.doctor.id),
    ));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.patientId).toBe(fx.patientId);
  });

  it("an unknown patient is refused as unknown_patient", async () => {
    await expect(patientReportsForDoctor(db, fx.doctor, newId(), READ_AT))
      .rejects.toMatchObject({ code: "unknown_patient" });
  });
});
