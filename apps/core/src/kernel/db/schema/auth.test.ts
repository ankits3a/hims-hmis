import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { users, roles, permissions, rolePermissions } from "./auth";
import type { Db } from "../client";

describe("auth tables", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("round-trips a user with defaults", async () => {
    await db.insert(users).values({
      id: "01HUSER00000000000000000A",
      username: "asha",
      fullName: "Asha K",
      passwordHash: "x",
    });
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.badgeVersion).toBe(0);
    expect(rows[0]!.active).toBe(true);
  });

  it("enforces username uniqueness", async () => {
    const base = { username: "asha", fullName: "Asha K", passwordHash: "x" };
    await db.insert(users).values({ ...base, id: "01A" });
    await expect(db.insert(users).values({ ...base, id: "01B" })).rejects.toThrow();
  });

  it("role_permissions requires a synced permission row (FK)", async () => {
    await db.insert(roles).values({ key: "cashier", title: "Cashier" });
    await expect(
      db.insert(rolePermissions).values({ roleKey: "cashier", permission: "billing.collect" }),
    ).rejects.toThrow();
    await db.insert(permissions).values({ permission: "billing.collect", module: "billing" });
    await db.insert(rolePermissions).values({ roleKey: "cashier", permission: "billing.collect" });
    const rows = await db.select().from(rolePermissions);
    expect(rows).toHaveLength(1);
  });
});
