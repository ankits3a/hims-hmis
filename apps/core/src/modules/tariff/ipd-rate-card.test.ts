import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { tariffVersions, services } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser, deactivateUser } from "../../kernel/auth/identity";
import { importIpdTariff, parseIpdTariffCsv, resolveIpdImportActor } from "./ipd-rate-card";
import { upsertGstCategory } from "./gst-config";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/** Review findings on PR #744. Fake round test values only. */
const HEADER = "incumbent_code,incumbent_name,bed_class,component,rate_rupees";

describe("IPD tariff CSV — row shape (review #744)", () => {
  it("refuses an unquoted grouped rate that splits into an extra cell, naming the row", () => {
    const r = parseIpdTariffCsv(`${HEADER}\nT-1,Test room,private,room,1,000\nT-2,Test nursing,private,nursing,\"1,000\"`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.line).toBe(2);
    expect(r.errors[0]?.problem).toMatch(/6 cells.*header has 5/);
    expect(r.rates.map((x) => [x.line, x.pricePaise])).toEqual([[3, 100000]]);
  });

  it("refuses a header that names a column twice", () => {
    const r = parseIpdTariffCsv(`${HEADER},rate_rupees\nT-1,Test room,private,room,100,200`);
    expect(r.errors.map((e) => e.line)).toEqual([1]);
    expect(r.errors[0]?.problem).toMatch(/rate_rupees.*more than once/);
    expect(r.rates).toEqual([]);
  });
});

describe("IPD tariff import — actor and concurrency (review #744)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    const a: Actor = { type: "system", id: "test" };
    await withTx(db, async (tx) => {
      for (const category of ["room_rent", "room_rent_icu", "ipd_care"]) {
        await upsertGstCategory(tx, a, { category, sacCode: "999311", exempt: true, rateBps: 0, specialRule: null, thresholdPaise: null });
      }
    });
  });

  it("--by refuses an inactive account", async () => {
    const { id } = await createUser(db, { username: "gone_clerk", fullName: "Gone Clerk", password: "p1234567" });
    await deactivateUser(db, id);
    await expect(resolveIpdImportActor(db, "gone_clerk")).rejects.toThrow(/no active account/);
    await expect(resolveIpdImportActor(db, "nobody_here")).rejects.toThrow(/no active account/);
  });

  it("two imports at once: exactly one draft; the other is refused cleanly, not a raw error", async () => {
    const csv = `${HEADER}\nT-1,Test room,private,room,1000`;
    const one: Actor = { type: "user", id: "test-a" };
    const two: Actor = { type: "user", id: "test-b" };
    const results = await Promise.allSettled([
      importIpdTariff(db, one, csv, { apply: true }),
      importIpdTariff(db, two, csv, { apply: true }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const values = results.map((r) => (r.status === "fulfilled" ? r.value : null));
    expect(values.filter((v) => v?.ok === true)).toHaveLength(1);
    const refused = values.find((v) => v?.ok === false);
    expect(refused !== undefined && refused !== null && !refused.ok && refused.errors[0]?.problem).toMatch(/already draft/);
    expect(await db.select().from(tariffVersions).where(eq(tariffVersions.status, "draft"))).toHaveLength(1);
    expect((await db.select().from(services)).filter((s) => s.code === "IPD_ROOM_PRIVATE")).toHaveLength(1);
  });
});
