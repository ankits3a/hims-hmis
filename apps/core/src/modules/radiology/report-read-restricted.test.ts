import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { orderItems, orders } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { draftReport, publishReport, signReport } from "./reports";
import { reportView } from "./read";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * One report, read by id, follows the same restricted rule as the doctor's results inbox
 * (`closed-loop.ts` / `waiting.ts` `treatedBy`): outside the performing department (F45 — holders of
 * `radiology.worklist.read`), a restricted study's report is read only by its ordering clinician or a
 * holder of `orders.read.restricted`; anyone else gets the same `null` an unknown id gets.
 */
describe("single imaging report read — restricted studies", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let other: Actor;
  let registry: ModuleRegistry;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const FRESH = new Date(NOW.getTime() - 60_000);
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    registry = new ModuleRegistry();
    registry.install({
      key: "radiology", title: "Rad", menu: [],
      permissions: ["radiology.worklist.read", "radiology.reports.read", "orders.read.restricted"], subscriptions: [],
    });
    await syncPermissions(db, registry);
    for (const p of ["radiology.worklist.read", "radiology.reports.read"]) {
      await grantPermissionToRole(db, registry, "radiologist", p);
      await grantPermissionToRole(db, registry, "radiographer", p);
    }
    await grantPermissionToRole(db, registry, "doctor", "radiology.reports.read");
    ({ actor: other } = await mkUser(db, "dr.other", ["doctor"]));
  });
  afterEach(() => { fx.unregister(); });

  const released = async (restricted: boolean) => {
    seq += 1;
    const study = await acquireStudy(db, fx, {
      idemKey: `rr${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
    });
    await db.update(orders).set({ orderingClinicianId: fx.doctor.id }).where(eq(orders.id, study.orderId));
    await db.update(orderItems).set({ restricted }).where(eq(orderItems.orderId, study.orderId));
    const draft = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: study.studyId, body: { findings: "Findings." }, impression: "Impression.",
    }));
    const { reportId } = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: study.studyId, reportId: draft.reportId, secondFactorAt: FRESH, now: NOW,
    }));
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: study.studyId, now: NOW }));
    return reportId;
  };

  it("a restricted study's report is not served to a doctor who did not order it", async () => {
    const reportId = await released(true);
    expect(await reportView(db, other, reportId)).toBeNull();
  });

  it("the ordering clinician, the department and a restricted-read holder still read it", async () => {
    const reportId = await released(true);
    expect((await reportView(db, fx.doctor, reportId))?.reportId).toBe(reportId);
    expect((await reportView(db, fx.radiographer, reportId))?.reportId).toBe(reportId);
    expect((await reportView(db, fx.radiologist, reportId))?.reportId).toBe(reportId);
    await grantPermissionToRole(db, registry, "doctor", "orders.read.restricted");
    expect((await reportView(db, other, reportId))?.reportId).toBe(reportId);
  });

  it("an unrestricted report stays readable by any holder of the report permission (DD16)", async () => {
    const reportId = await released(false);
    expect((await reportView(db, other, reportId))?.reportId).toBe(reportId);
  });
});
