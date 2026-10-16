import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantLabResultPermissions, runLabOrder, seedLabDeskBase } from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { orderItems } from "../../kernel/db/schema";
import { getReport, publishReport } from "./reports";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * One lab report, read by id (`GET /lab/reports/:reportId`), follows the lab's restricted-test rule
 * (DD11, as `patient-results.ts` applies it): a restricted test is shown to its ordering clinician, a
 * holder of `orders.read.restricted`, and the lab itself (bench, pathologist, report counter); for
 * anyone else the panel is omitted, and a report with nothing left is refused as unknown.
 */
const AT = new Date("2026-08-30T06:00:00Z");
const READ_AT = new Date(AT.getTime() + 3600_000);

describe("single lab report read — restricted tests", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let other: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    other = await mkUser(db, "dr.other", ["doctor"]);
    await grantPermissionToRole(db, fx.registry, "doctor", "lab.results.read");
  });
  afterEach(() => { fx.unregister(); });

  const published = async (codes: string[], restrict: number[]) => {
    const run = await runLabOrder(db, fx, codes, { at: AT });
    for (const i of restrict) await db.update(orderItems).set({ restricted: true }).where(eq(orderItems.id, run.itemIds[i]!));
    const { reportId } = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    return { run, reportId };
  };
  const panelItems = async (actor: Actor, reportId: string) =>
    (await getReport(db, actor, reportId, READ_AT)).snapshot.panels.map((p) => p.orderItemId).sort();

  it("a doctor who did not order it does not see the restricted test", async () => {
    const { run, reportId } = await published(["TSH", "GLUF"], [0]);
    expect(await panelItems(other.actor, reportId)).toEqual([run.itemIds[1]!]);
  });

  it("a report holding only a restricted test is refused to that doctor as unknown", async () => {
    const { reportId } = await published(["TSH"], [0]);
    await expect(getReport(db, other.actor, reportId, READ_AT)).rejects.toMatchObject({ code: "unknown_report" });
  });

  it("the ordering clinician, the bench, the report counter and a restricted-read holder still see every test", async () => {
    const { run, reportId } = await published(["TSH", "GLUF"], [0]);
    const all = [...run.itemIds].sort();
    expect(await panelItems(fx.pathologist.actor, reportId)).toEqual(all);
    expect(await panelItems(fx.bench.actor, reportId)).toEqual(all);
    expect(await panelItems(fx.desk.actor, reportId)).toEqual(all);
    await grantPermissionToRole(db, fx.registry, "doctor", "orders.read.restricted");
    expect(await panelItems(other.actor, reportId)).toEqual(all);
  });

  it("an unrestricted report is unchanged for any holder of the read permission", async () => {
    const { run, reportId } = await published(["TSH", "GLUF"], []);
    expect(await panelItems(other.actor, reportId)).toEqual([...run.itemIds].sort());
  });
});
