import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { actorHoldsAnyRole, usersHoldingRole } from "./roles";
import { createUser } from "../auth/identity";
import { createRole, assignRole } from "../auth/permissions";
import { grantTempRole } from "../auth/temp-roles";
import { tempRoleGrants } from "../db/schema";
import { withTx } from "../db/client";
import { loadConfig } from "../config";
import type { Db } from "../db/client";

const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

describe("workflow role helpers", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("sees permanent assignments at any scope", async () => {
    const { id } = await createUser(db, { username: "n1", fullName: "N", password: "p1234567" });
    await createRole(db, "nurse", "Nurse");
    await assignRole(db, { userId: id, roleKey: "nurse", scopeType: "department", scopeId: "opd" });
    await withTx(db, async (tx) => {
      expect(await actorHoldsAnyRole(tx, id, ["nurse", "doctor"])).toBe(true);
      expect(await actorHoldsAnyRole(tx, id, ["doctor"])).toBe(false);
      expect(await actorHoldsAnyRole(tx, id, [])).toBe(false);
    });
  });

  it("sees unexpired temp grants and ignores expired ones", async () => {
    const { id: grantor } = await createUser(db, { username: "g1", fullName: "G", password: "p1234567" });
    const { id: user } = await createUser(db, { username: "n2", fullName: "N", password: "p1234567" });
    const { id: lapsed } = await createUser(db, { username: "n3", fullName: "L", password: "p1234567" });
    await createRole(db, "duty_manager", "Duty Manager");
    await grantTempRole(db, cfg, { type: "user", id: grantor }, {
      userId: user, roleKey: "duty_manager", reason: "cover", ttlMinutes: 30,
    });
    await db.insert(tempRoleGrants).values({
      id: "01HGRANTLAPSED00000000000A", userId: lapsed, roleKey: "duty_manager",
      grantedBy: grantor, kind: "granted", reason: "lapsed", expiresAt: new Date(Date.now() - 60_000),
    });
    await withTx(db, async (tx) => {
      expect(await actorHoldsAnyRole(tx, user, ["duty_manager"])).toBe(true);
      expect(await actorHoldsAnyRole(tx, lapsed, ["duty_manager"])).toBe(false);
      expect(await usersHoldingRole(tx, "duty_manager")).toEqual([user]);
    });
  });

  it("resolves holders deduped and sorted across permanent + temp holdings", async () => {
    const { id: a } = await createUser(db, { username: "a", fullName: "A", password: "p1234567" });
    const { id: b } = await createUser(db, { username: "b", fullName: "B", password: "p1234567" });
    const { id: g } = await createUser(db, { username: "g", fullName: "G", password: "p1234567" });
    await createRole(db, "reviewer", "Reviewer");
    await assignRole(db, { userId: a, roleKey: "reviewer", scopeType: "hospital" });
    await assignRole(db, { userId: b, roleKey: "reviewer", scopeType: "floor", scopeId: "f1" });
    await grantTempRole(db, cfg, { type: "user", id: g }, {
      userId: a, roleKey: "reviewer", reason: "double-holding must dedupe", ttlMinutes: 30,
    });
    await withTx(db, async (tx) => {
      expect(await usersHoldingRole(tx, "reviewer")).toEqual([a, b].sort());
      expect(await usersHoldingRole(tx, "nobody_role")).toEqual([]);
    });
  });
});
