import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { setupRadiologyFixture } from "../../../test/helpers/radiology";
import { WALK_IN_PRICES, setupImagingWalkIn } from "../../../test/helpers/imaging-walk-in";
import { mkUser } from "../../../test/helpers/opd";
import { opdDepartments, opdDoctors, opdEncounters, orders } from "../../kernel/db/schema";
import { deskVisitsToday, deskWalkInView, placeWalkInOrder } from "./desk";
import type { DeskWalkInOrderInput } from "./desk";
import type { ImagingWalkInFixture } from "../../../test/helpers/imaging-walk-in";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * #1079 (IM2b) — the imaging walk-in's edges, beyond the spec's four acceptance checks
 * (`acceptance/imaging-walk-in-1079.test.ts`): who answers when radiology has several radiologists, a
 * department not stood up yet, the desk door finding the walk-in again, the walk-in door's read, the
 * act's own permission and the retried click. Every instant is written by hand.
 */
const DAY = "2026-08-31";
const NOW = new Date("2026-08-31T06:07:00.000Z");
const SLIP = { name: "Dr. Anil Verma", registrationNo: "BMC/44117" };

describe("#1079 — the imaging desk's walk-in for an outside referral", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let w: ImagingWalkInFixture;

  jest.setTimeout(120_000);
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    w = await setupImagingWalkIn(db, fx, { serviceDate: DAY });
  });
  afterEach(() => { w.restore(); });

  const slip = (over: Partial<DeskWalkInOrderInput> = {}): DeskWalkInOrderInput => ({
    patientId: w.patientId, indication: "Pain right upper abdomen", items: [{ serviceId: fx.services["USG-ABDO"]! }],
    referrer: SLIP, ...over,
  });
  const code = (e: unknown): unknown => (e as { code?: unknown }).code;
  const visitsOf = () => db.select().from(opdEncounters).where(eq(opdEncounters.patientId, w.patientId));

  it("two radiologists: the act refuses to choose, and opens under the one the desk names", async () => {
    const second = await mkUser(db, "dr.kapoor", ["radiologist"]);
    const secondDoctorId = newId();
    await db.insert(opdDoctors).values({
      id: secondDoctorId, userId: second.id, departmentId: w.radDepartmentId, displayName: "Dr Kapoor",
      code: "DR-RAD-02", registrationNo: "JMC/RAD/2019", active: true, createdBy: "t", updatedBy: "t",
    });
    const refused = await placeWalkInOrder(db, w.desk, fx.decls, slip(), undefined, NOW).then(() => "placed", code);
    expect(refused).toBe("unknown_doctor");
    expect(await visitsOf()).toHaveLength(0);

    const placed = await placeWalkInOrder(db, w.desk, fx.decls, slip({ doctorId: secondDoctorId }), undefined, NOW);
    const [visit] = await visitsOf();
    expect(visit!.doctorId).toBe(secondDoctorId);
    const [order] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(order!.orderingClinicianId).toBe(second.id);
  });

  it("no RAD department yet: refused by name, and nothing is left behind", async () => {
    await db.delete(opdDoctors).where(eq(opdDoctors.departmentId, w.radDepartmentId));
    await db.delete(opdDepartments).where(eq(opdDepartments.id, w.radDepartmentId));
    expect(await placeWalkInOrder(db, w.desk, fx.decls, slip(), undefined, NOW).then(() => "placed", code)).toBe("unknown_department");
    expect(await visitsOf()).toHaveLength(0);
    expect(await deskWalkInView(db, w.desk, { now: NOW })).toMatchObject({ bookActive: true, radiologists: [] });
  });

  it("a refused order leaves no visit behind: a study the book does not name", async () => {
    const refused = await placeWalkInOrder(db, w.desk, fx.decls, slip({ items: [{ serviceId: "NOT-A-SERVICE" }] }), undefined, NOW)
      .then(() => "placed", code);
    expect(refused).toBe("unknown_study_type");
    expect(await visitsOf()).toHaveLength(0);
  });

  it("the desk door finds the walk-in again among the patient's visits of today; a pharmacy visit stays out", async () => {
    const placed = await placeWalkInOrder(db, w.desk, fx.decls, slip(), undefined, NOW);
    await db.insert(opdEncounters).values({
      id: newId(), visitNo: "V2608319999", patientId: w.patientId, type: "pharmacy", workflowInstanceId: newId(),
      serviceDate: DAY, visitType: "new", openedBy: "t", updatedBy: "t",
    });
    const visits = await deskVisitsToday(db, w.desk, { patientId: w.patientId, now: NOW });
    expect(visits.map((v) => v.encounterNo)).toEqual([placed.encounterNo]);
  });

  it("the walk-in door's read: the priced book and the radiologist who answers", async () => {
    const view = await deskWalkInView(db, w.desk, { now: NOW });
    expect(view.bookActive).toBe(true);
    expect(view.radiologists).toEqual([{ doctorId: w.radiologistDoctorId, displayName: "Dr Rao", userId: w.radiologistUserId }]);
    const usg = view.book.find((b) => b.serviceId === fx.services["USG-ABDO"]);
    expect(usg?.pricePaise).toBe(WALK_IN_PRICES["USG-ABDO"]);
  });

  it("only a desk seat opens a walk-in: without radiology.schedule the act is forbidden and opens nothing", async () => {
    const refused = await placeWalkInOrder(db, fx.doctor, fx.decls, slip(), undefined, NOW).then(() => "placed", code);
    expect(refused).toBe("forbidden");
    expect(await visitsOf()).toHaveLength(0);
  });

  it("a retried click with the same key replays: one visit, one order", async () => {
    const first = await placeWalkInOrder(db, w.desk, fx.decls, slip(), "walk-in-retry", NOW);
    const again = await placeWalkInOrder(db, w.desk, fx.decls, slip(), "walk-in-retry", NOW);
    expect(again).toEqual(first);
    expect(await visitsOf()).toHaveLength(1);
    expect(await db.select().from(orders).where(and(eq(orders.patientId, w.patientId), eq(orders.kind, "imaging")))).toHaveLength(1);
  });
});
