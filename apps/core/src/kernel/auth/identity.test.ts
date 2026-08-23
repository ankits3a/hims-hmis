import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  createUser, verifyPassword, setPin, verifyPin, rotateBadge, resolveBadge, deactivateUser,
  reactivateUser, setPassword,
} from "./identity";
import { loadConfig } from "../config";
import { users } from "../db/schema";
import type { Db } from "../db/client";

const cfg = loadConfig({
  DATABASE_URL: "postgres://unused",
  SECRET_KEY: process.env.SECRET_KEY!,
});

describe("identity", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("creates a user and verifies the password", async () => {
    const { id } = await createUser(db, { username: "asha", fullName: "Asha K", password: "s3cret-pass" });
    expect(id).toHaveLength(26);
    expect(await verifyPassword(db, "asha", "s3cret-pass")).toEqual({ userId: id });
    expect(await verifyPassword(db, "asha", "wrong")).toBeNull();
    expect(await verifyPassword(db, "nobody", "s3cret-pass")).toBeNull();
  });

  it("rejects duplicate usernames", async () => {
    await createUser(db, { username: "asha", fullName: "A", password: "p1234567" });
    await expect(createUser(db, { username: "asha", fullName: "B", password: "p1234567" })).rejects.toThrow();
  });

  it("verifies a PIN set after creation", async () => {
    const { id } = await createUser(db, { username: "ravi", fullName: "Ravi", password: "p1234567" });
    expect(await verifyPin(db, id, "482913")).toBe(false); // no pin yet
    await setPin(db, id, "482913");
    expect(await verifyPin(db, id, "482913")).toBe(true);
    expect(await verifyPin(db, id, "000000")).toBe(false);
  });

  it("issues and rotates badge tokens", async () => {
    const { id } = await createUser(db, { username: "meena", fullName: "Meena", password: "p1234567" });
    const first = await rotateBadge(db, cfg, id);
    expect(first.badgeVersion).toBe(1);
    expect(await resolveBadge(db, cfg, first.badgeToken)).toEqual({ userId: id });
    const second = await rotateBadge(db, cfg, id);
    expect(second.badgeVersion).toBe(2);
    expect(await resolveBadge(db, cfg, first.badgeToken)).toBeNull(); // old badge dead
    expect(await resolveBadge(db, cfg, second.badgeToken)).toEqual({ userId: id });
  });

  // ───────────── PLAN 11e Q3/D1 — the two writers that did not exist before this phase ─────────────

  it("setPassword replaces the credential, and the OLD one stops working", async () => {
    const { id } = await createUser(db, { username: "asha", fullName: "Asha K", password: "s3cret-pass" });
    await setPassword(db, id, "a-new-one-entirely", { mustChangePassword: true });
    // Both directions. Asserting only the new password would pass just as well against an
    // implementation that ADDED a hash without replacing the old — which is not a reset.
    expect(await verifyPassword(db, "asha", "s3cret-pass")).toBeNull();
    expect(await verifyPassword(db, "asha", "a-new-one-entirely")).toEqual({ userId: id });
  });

  it("setPassword carries mustChangePassword BOTH ways — the flag is an argument, not a side effect", async () => {
    const { id } = await createUser(db, { username: "ravi", fullName: "Ravi", password: "p1234567" });
    const flag = async (): Promise<boolean> => {
      const rows = await db.select({ f: users.mustChangePassword }).from(users).where(eq(users.id, id));
      return rows[0]!.f;
    };
    expect(await flag()).toBe(false); // createUser's default — the seeds and every fixture rely on it

    await setPassword(db, id, "issued-by-an-admin", { mustChangePassword: true });
    expect(await flag()).toBe(true);
    await setPassword(db, id, "chosen-by-the-human", { mustChangePassword: false });
    expect(await flag()).toBe(false);

    // …and the create-time opt-in, which is what the admin-create route uses (D2).
    const { id: provisioned } = await createUser(db, {
      username: "new-hire", fullName: "New Hire", password: "provisional-one", mustChangePassword: true,
    });
    const rows = await db.select({ f: users.mustChangePassword }).from(users).where(eq(users.id, provisioned));
    expect(rows[0]!.f).toBe(true);
  });

  it("reactivateUser reverses a deactivation and nothing else", async () => {
    const { id } = await createUser(db, { username: "back", fullName: "Back", password: "p1234567", pin: "112233" });
    await deactivateUser(db, id);
    expect(await verifyPassword(db, "back", "p1234567")).toBeNull();

    await reactivateUser(db, id);
    expect(await verifyPassword(db, "back", "p1234567")).toEqual({ userId: id });
    expect(await verifyPin(db, id, "112233")).toBe(true); // the PIN was never touched by either act
  });

  it("inactive users fail every credential path", async () => {
    const { id } = await createUser(db, { username: "gone", fullName: "Gone", password: "p1234567", pin: "112233" });
    const badge = await rotateBadge(db, cfg, id);
    await deactivateUser(db, id);
    expect(await verifyPassword(db, "gone", "p1234567")).toBeNull();
    expect(await verifyPin(db, id, "112233")).toBe(false);
    expect(await resolveBadge(db, cfg, badge.badgeToken)).toBeNull();
  });
});
