import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantLabResultPermissions, runLabOrder, seedLabDeskBase } from "../../../test/helpers/lab";
import { labAnalytes, labResults, orderItems } from "../../kernel/db/schema";
import { printedNumber, resultedValuesForOrders } from "./index";
import { amendResult } from "./results";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * IPD E5.3 (#740) — the inpatient copilot reads an admission's SIGNED values in a window through the lab's index
 * (`resultedValuesForOrders`). Every row is built by the lab's real writers (`runLabOrder`); the only hand-written
 * column is `restricted`, as in `patient-results.test.ts`. Instants are explicit; nothing reads the real clock.
 */
const AT = new Date("2026-08-30T06:00:00Z");
const LATER = new Date(AT.getTime() + 3600_000);
const BEFORE = new Date(AT.getTime() - 3600_000);
const AFTER = new Date(AT.getTime() + 2 * 3600_000);

describe("resultedValuesForOrders — an admission's signed values in a window", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
  });
  afterEach(() => { fx.unregister(); });

  it("answers test, analyte, the printed value, unit, flag and the signature's instant; critical and abnormal are named", async () => {
    const tsh = await runLabOrder(db, fx, ["TSH"], { at: AT, values: { TSH: "9.5" } });
    const glu = await runLabOrder(db, fx, ["GLUF"], { at: LATER, values: { GLUF: "500" }, encounterNo: fx.newVisit() });

    const { values, truncated } = await resultedValuesForOrders(db, { orderIds: [tsh.orderId, glu.orderId], since: BEFORE, until: AFTER });
    expect(truncated).toBe(false);
    expect(values.map((v) => [v.analyteName, v.value, v.unit, v.flag, v.abnormal, v.critical, v.resultedAt.toISOString()])).toEqual([
      ["Glucose, fasting", "500", "mg/dL", "HH", true, true, LATER.toISOString()],
      ["TSH", "9.50", "uIU/mL", "H", true, false, AT.toISOString()],
    ]);
    expect(values[0]).toMatchObject({ testName: "Glucose — fasting", kind: "numeric", orderItemId: glu.itemIds[0] });
  });

  it("only the named orders, only inside (since, until], only signed, never superseded, never restricted", async () => {
    const mine = await runLabOrder(db, fx, ["TSH"], { at: AT, values: { TSH: "2.5" } });
    const other = await runLabOrder(db, fx, ["GLUF"], { at: AT, encounterNo: fx.newVisit() });
    const unsigned = await runLabOrder(db, fx, ["GLUF"], { at: AT, verify: false, encounterNo: fx.newVisit() });

    const read = (since: Date, until: Date, orderIds = [mine.orderId, unsigned.orderId]) => resultedValuesForOrders(db, { orderIds, since, until });
    expect((await read(BEFORE, AFTER)).values.map((v) => v.value)).toEqual(["2.50"]);
    expect((await read(AT, AFTER)).values).toEqual([]); // the window is open at `since`
    expect((await read(BEFORE, AT)).values).toHaveLength(1); // and closed at `until`
    expect((await read(BEFORE, AFTER, [])).values).toEqual([]);
    expect((await read(BEFORE, AFTER, [other.orderId])).values).toHaveLength(1);

    const tshId = (await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, "TSH")))[0]!.id;
    const [prior] = await db.select().from(labResults).where(eq(labResults.analyteId, tshId));
    await amendResult(db, fx.pathologist.actor, { resultId: prior!.id, value: "9.9" }, LATER);
    expect((await read(BEFORE, AFTER)).values.map((v) => v.value)).toEqual(["9.90"]);

    await db.update(orderItems).set({ restricted: true }).where(eq(orderItems.id, mine.itemIds[0]!));
    expect((await read(BEFORE, AFTER)).values).toEqual([]);
  });

  it("cuts at the limit, newest kept, and says so", async () => {
    const a = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const b = await runLabOrder(db, fx, ["GLUF"], { at: LATER, encounterNo: fx.newVisit() });
    const cut = await resultedValuesForOrders(db, { orderIds: [a.orderId, b.orderId], since: BEFORE, until: AFTER, limit: 1 });
    expect(cut.truncated).toBe(true);
    expect(cut.values.map((v) => v.resultedAt.toISOString())).toEqual([LATER.toISOString()]);
  });

  it("prints a number to the analyte's decimals", () => {
    expect([printedNumber("6.8000", 1), printedNumber("500.0000", 0), printedNumber("0.0350", 3), printedNumber("-3.0000", 0)]).toEqual(["6.8", "500", "0.035", "-3"]);
  });
});
