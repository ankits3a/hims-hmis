import { authenticator } from "otplib";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser } from "./identity";
import { enrollTotp, confirmTotp, verifyTotpCode, secondFactorFresh } from "./totp";
import { loadConfig } from "../config";
import { userTotp } from "../db/schema";
import type { Db } from "../db/client";

const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

describe("totp", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("enrolls with a sealed seed, confirms with a valid code", async () => {
    const { id } = await createUser(db, { username: "asha", fullName: "A", password: "p1234567" });
    const { secret, otpauthUrl } = await enrollTotp(db, cfg, id);
    expect(otpauthUrl).toContain("otpauth://totp/");
    const stored = (await db.select().from(userTotp).where(eq(userTotp.userId, id)))[0]!;
    expect(stored.secretSealed).not.toContain(secret); // sealed, never plaintext
    expect(stored.enabledAt).toBeNull();
    expect(await verifyTotpCode(db, cfg, id, authenticator.generate(secret))).toBe(false); // not enabled yet
    expect(await confirmTotp(db, cfg, id, "000000")).toBe(false);
    expect(await confirmTotp(db, cfg, id, authenticator.generate(secret))).toBe(true);
    expect(await verifyTotpCode(db, cfg, id, authenticator.generate(secret))).toBe(true);
    expect(await verifyTotpCode(db, cfg, id, "000000")).toBe(false);
  });

  it("secondFactorFresh honours the window", () => {
    const now = new Date("2026-08-12T10:00:00Z");
    expect(secondFactorFresh({ secondFactorAt: null }, 5, now)).toBe(false);
    expect(secondFactorFresh({ secondFactorAt: new Date("2026-08-12T09:56:00Z") }, 5, now)).toBe(true);
    expect(secondFactorFresh({ secondFactorAt: new Date("2026-08-12T09:54:00Z") }, 5, now)).toBe(false);
  });
});
