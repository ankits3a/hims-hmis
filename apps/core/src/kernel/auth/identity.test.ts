import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  createUser, verifyPassword, setPin, verifyPin, rotateBadge, resolveBadge, deactivateUser,
} from "./identity";
import { loadConfig } from "../config";
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

  it("inactive users fail every credential path", async () => {
    const { id } = await createUser(db, { username: "gone", fullName: "Gone", password: "p1234567", pin: "112233" });
    const badge = await rotateBadge(db, cfg, id);
    await deactivateUser(db, id);
    expect(await verifyPassword(db, "gone", "p1234567")).toBeNull();
    expect(await verifyPin(db, id, "112233")).toBe(false);
    expect(await resolveBadge(db, cfg, badge.badgeToken)).toBeNull();
  });
});
