import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser } from "./identity";
import { useBreakGlass, hasActiveBreakGlass, pendingReviews, recordReview } from "./break-glass";
import { loadConfig } from "../config";
import { events } from "../db/schema";
import type { Db } from "../db/client";

const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

describe("break-glass", () => {
  let db: Db; let teardown: () => Promise<void>;
  let er: { type: "user"; id: string }; // real user row — break_glass_grants.user_id is FK'd
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => {
    await truncateAll(db);
    const { id } = await createUser(db, { username: "er-doc", fullName: "ER Doc", password: "p1234567" });
    er = { type: "user", id };
  });
  afterAll(async () => { await teardown(); });

  it("grants instantly and events loudly in one transaction", async () => {
    const { grantId, expiresAt } = await useBreakGlass(db, cfg, er, { patientId: "P1", reason: "unconscious ER arrival" });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const rows = await db.select().from(events).where(eq(events.name, "break_glass.used"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.patientId).toBe("P1");
    expect((rows[0]!.payload as { grantId: string }).grantId).toBe(grantId);
  });

  it("scopes active grants to the granted patient; null covers any", async () => {
    await useBreakGlass(db, cfg, er, { patientId: "P1", reason: "r" });
    expect(await hasActiveBreakGlass(db, er.id, "P1")).toBe(true);
    expect(await hasActiveBreakGlass(db, er.id, "P2")).toBe(false);
    expect(await hasActiveBreakGlass(db, "someone-else", "P1")).toBe(false);
    await useBreakGlass(db, cfg, er, { reason: "unknown patient" });
    expect(await hasActiveBreakGlass(db, er.id, "P2")).toBe(true);
  });

  it("review queue lists unreviewed grants and closes on review", async () => {
    const { grantId } = await useBreakGlass(db, cfg, er, { patientId: "P1", reason: "r" });
    expect(await pendingReviews(db)).toHaveLength(1);
    await recordReview(db, grantId, { type: "user", id: "reviewer-1" }, "justified");
    expect(await pendingReviews(db)).toHaveLength(0);
  });
});
