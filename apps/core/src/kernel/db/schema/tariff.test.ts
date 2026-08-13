import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  adjustmentRules, gstConfig, gstSettings, regulatedPrices, services, tariffItems, tariffVersions,
} from "./index";
import type { Db } from "../client";

let db: Db;
let teardown: () => Promise<void>;

beforeAll(async () => {
  ({ db, teardown } = await setupTestDb());
});
afterAll(async () => teardown());
beforeEach(async () => truncateAll(db));

async function seedMinimal(): Promise<{ serviceId: string; versionId: string }> {
  await db.insert(services).values({ id: "s1", code: "SVC-1", name: "Svc", category: "pharmacy", regulated: true, createdBy: "t", updatedBy: "t" });
  await db.insert(tariffVersions).values({ id: "v1", versionNo: 1, createdBy: "t" });
  return { serviceId: "s1", versionId: "v1" };
}

test("bigint paise columns round-trip as JS numbers (never strings, never floats)", async () => {
  const { serviceId, versionId } = await seedMinimal();
  await db.insert(tariffItems).values({ id: "i1", versionId, serviceId, pricePaise: 123456789, updatedBy: "t" });
  await db.insert(regulatedPrices).values({ id: "r1", serviceId, mrpPaise: 987654321, ceilingPaise: 500, effectiveFrom: new Date("2026-01-01T00:00:00Z"), createdBy: "t" });
  const item = (await db.select().from(tariffItems))[0];
  const reg = (await db.select().from(regulatedPrices))[0];
  expect(item?.pricePaise).toBe(123456789);
  expect(typeof item?.pricePaise).toBe("number");
  expect(reg?.mrpPaise).toBe(987654321);
  expect(reg?.ceilingPaise).toBe(500);
});

test("unique constraints hold: service code, version number, one price per (version, service)", async () => {
  const { serviceId, versionId } = await seedMinimal();
  await expect(db.insert(services).values({ id: "s2", code: "SVC-1", name: "Dup", category: "pharmacy", createdBy: "t", updatedBy: "t" })).rejects.toThrow();
  await expect(db.insert(tariffVersions).values({ id: "v2", versionNo: 1, createdBy: "t" })).rejects.toThrow();
  await db.insert(tariffItems).values({ id: "i1", versionId, serviceId, pricePaise: 100, updatedBy: "t" });
  await expect(db.insert(tariffItems).values({ id: "i2", versionId, serviceId, pricePaise: 200, updatedBy: "t" })).rejects.toThrow();
});

test("truncateAll empties every tariff table in one statement (FK group proof — §3.12)", async () => {
  const { serviceId, versionId } = await seedMinimal();
  await db.insert(tariffItems).values({ id: "i1", versionId, serviceId, pricePaise: 100, updatedBy: "t" });
  await db.insert(regulatedPrices).values({ id: "r1", serviceId, effectiveFrom: new Date(), mrpPaise: 1, ceilingPaise: null, createdBy: "t" });
  await db.insert(adjustmentRules).values({ id: "a1", ruleKey: "R1", sourceKey: "rule", title: "T", params: {}, createdBy: "t", updatedBy: "t" });
  await db.insert(gstConfig).values({ category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, updatedBy: "t" });
  await db.insert(gstSettings).values({ id: "main", updatedBy: "t" });
  await truncateAll(db);
  // Unrolled on purpose: a loop over a UNION of table types does not typecheck against drizzle's from() overloads.
  expect((await db.select().from(services)).length).toBe(0);
  expect((await db.select().from(tariffVersions)).length).toBe(0);
  expect((await db.select().from(tariffItems)).length).toBe(0);
  expect((await db.select().from(regulatedPrices)).length).toBe(0);
  expect((await db.select().from(adjustmentRules)).length).toBe(0);
  expect((await db.select().from(gstConfig)).length).toBe(0);
  expect((await db.select().from(gstSettings)).length).toBe(0);
});
