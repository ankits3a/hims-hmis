import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { pushSubscriptions, userReachProfiles } from "./reach";
import { users } from "./auth";
import type { Db } from "../client";

/**
 * ═══ PHASE O T4 — THE TWO REACH TABLES, ASSERTED BY EXECUTION ═══
 *
 * The `orders.test.ts` rule: "the constraint exists in `pg_constraint`" proves nothing about
 * what Postgres will do with a row. Every assertion below issues the real statement.
 */
const USER_A = "01HREACHUSERA000000000AA";
const USER_B = "01HREACHUSERB000000000BB";

describe("the reach tables (phase O T4)", () => {
  let db: Db; let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(users).values([
      { id: USER_A, username: "reacha", fullName: "Asha K", staffCode: "EMP-R001", passwordHash: "x" },
      { id: USER_B, username: "reachb", fullName: "Bala R", staffCode: "EMP-R002", passwordHash: "x" },
    ]);
  });
  afterAll(async () => { await teardown(); });

  describe("user_reach_profiles", () => {
    it("a row with only a user id carries the class-neutral defaults", async () => {
      await db.insert(userReachProfiles).values({ userId: USER_A, createdBy: "seed", updatedBy: "seed" });
      const [row] = await db.select().from(userReachProfiles);
      expect(row!.language).toBe("en"); // RO-3: English primary
      expect(row!.ladder).toEqual(["web_push", "whatsapp", "sms"]); // RU-4's order
      expect(row!.quietExempt).toBe(false);
      expect(row!.sharedPhone).toBe(false);
      // R2 — never asked is not the same as declined, which is why it is an instant.
      expect(row!.consentAt).toBeNull();
    });

    it("refuses a language outside the two the templates exist in", async () => {
      await expect(
        db.insert(userReachProfiles).values({ userId: USER_A, language: "ta", createdBy: "s", updatedBy: "s" }),
      ).rejects.toThrow();
    });

    it("refuses an EMPTY ladder — a person nothing can reach looks exactly like a quiet one", async () => {
      await expect(
        db.insert(userReachProfiles).values({ userId: USER_A, ladder: [], createdBy: "s", updatedBy: "s" }),
      ).rejects.toThrow();
    });

    it("refuses a channel that is not a channel — a ladder naming `voice` reaches nobody", async () => {
      // §Q.4 asks for voice for drivers and §8 owes it. Until the adapter exists, a profile
      // claiming it would be a configured-looking route to silence.
      await expect(
        db.insert(userReachProfiles).values({ userId: USER_A, ladder: ["voice"], createdBy: "s", updatedBy: "s" }),
      ).rejects.toThrow();
      await expect(
        db.insert(userReachProfiles).values({ userId: USER_A, ladder: ["web_push", "email"], createdBy: "s", updatedBy: "s" }),
      ).rejects.toThrow();
    });

    it("ACCEPTS every shorter ladder the classes actually use (5A.1 — the permitted direction)", async () => {
      await db.insert(userReachProfiles).values([
        { userId: USER_A, ladder: ["web_push"], createdBy: "s", updatedBy: "s" },               // screen seats
        { userId: USER_B, ladder: ["whatsapp", "sms"], language: "hi", createdBy: "s", updatedBy: "s" }, // support
      ]);
      expect(await db.select().from(userReachProfiles)).toHaveLength(2);
    });

    it("is one row per person — the PK is the user, not a surrogate", async () => {
      await db.insert(userReachProfiles).values({ userId: USER_A, createdBy: "s", updatedBy: "s" });
      await expect(
        db.insert(userReachProfiles).values({ userId: USER_A, createdBy: "s", updatedBy: "s" }),
      ).rejects.toThrow();
    });
  });

  describe("push_subscriptions", () => {
    const sub = (id: string, userId: string, endpoint: string) => ({
      id, userId, endpoint, p256dh: "BPk", auth: "s3cr3t",
    });

    it("holds MANY browsers for one person — that is the whole point of the table", async () => {
      await db.insert(pushSubscriptions).values([
        sub("01HPUSH0000000000000001", USER_A, "https://fcm.example.test/phone"),
        sub("01HPUSH0000000000000002", USER_A, "https://fcm.example.test/desktop"),
      ]);
      expect(await db.select().from(pushSubscriptions)).toHaveLength(2);
    });

    it("refuses the same endpoint twice — the browser mints it, so a repeat is the same browser", async () => {
      await db.insert(pushSubscriptions).values(sub("01HPUSH0000000000000001", USER_A, "https://fcm.example.test/x"));
      await expect(
        db.insert(pushSubscriptions).values(sub("01HPUSH0000000000000003", USER_B, "https://fcm.example.test/x")),
      ).rejects.toThrow();
    });

    it("requires the user to be a real one, and keeps a revoked row rather than deleting it", async () => {
      await expect(
        db.insert(pushSubscriptions).values(sub("01HPUSH0000000000000004", "01HNOSUCHUSER00000000000", "https://x.test/y")),
      ).rejects.toThrow();

      await db.insert(pushSubscriptions).values({
        ...sub("01HPUSH0000000000000005", USER_A, "https://fcm.example.test/gone"),
        revokedAt: new Date("2026-09-21T10:00:00.000Z"),
      });
      const [row] = await db.select().from(pushSubscriptions);
      // A revocation is the RECORD that a browser used to be reachable and stopped being — it
      // is what tells a supervisor why somebody stopped answering.
      expect(row!.revokedAt).toEqual(new Date("2026-09-21T10:00:00.000Z"));
    });

    it("the ladder CHECK's vocabulary is the one the code uses — the SQL and TS copies agree", async () => {
      const [{ def }] = (await db.execute(
        sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'user_reach_profiles_ladder_ck'`,
      )).rows as [{ def: string }];
      const quoted = [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      expect([...quoted].sort()).toEqual(["sms", "web_push", "whatsapp"]);
    });
  });
});
