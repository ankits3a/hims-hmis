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
    const enrolled = await enrollTotp(db, cfg, id, { password: "p1234567" });
    if (!enrolled.ok) throw new Error(`enrol refused: ${enrolled.reason}`);
    const { secret, otpauthUrl } = enrolled;
    expect(otpauthUrl).toContain("otpauth://totp/");
    const stored = (await db.select().from(userTotp).where(eq(userTotp.userId, id)))[0]!;
    expect(stored.secretSealed).not.toContain(secret); // sealed, never plaintext
    expect(stored.enabledAt).toBeNull();
    expect((await verifyTotpCode(db, cfg, id, authenticator.generate(secret))).ok).toBe(false); // not enabled yet
    expect((await confirmTotp(db, cfg, id, "000000")).ok).toBe(false);
    expect((await confirmTotp(db, cfg, id, authenticator.generate(secret))).ok).toBe(true);
    // The confirm SPENT the current step's code (WASA M-02), so verification uses the next step's.
    const next = authenticator.clone({ epoch: Date.now() + 30_000 }).generate(secret);
    expect((await verifyTotpCode(db, cfg, id, next)).ok).toBe(true);
    expect((await verifyTotpCode(db, cfg, id, "000000")).ok).toBe(false);
  });

  it("secondFactorFresh honours the window", () => {
    const now = new Date("2026-08-12T10:00:00Z");
    expect(secondFactorFresh({ secondFactorAt: null }, 5, now)).toBe(false);
    expect(secondFactorFresh({ secondFactorAt: new Date("2026-08-12T09:56:00Z") }, 5, now)).toBe(true);
    expect(secondFactorFresh({ secondFactorAt: new Date("2026-08-12T09:54:00Z") }, 5, now)).toBe(false);
  });

  /**
   * WASA M-02 — THE TOTP LIFECYCLE. Three holes, one per `describe` leg below:
   *   1. `enrollTotp` overwrote the secret on a session alone, so a stolen token could replace the
   *      victim's factor with its own (ASVS 2.5.x / V3.7.1: re-authenticate before changing an
   *      authenticator);
   *   2. an accepted code could be accepted again inside its ±1-step window (ASVS 2.8.4);
   *   3. nothing throttled verification, so six digits could be walked by any session holder.
   */
  describe("WASA M-02", () => {
    const PASSWORD = "the-real-password-1";
    const at = (secret: string, offsetSteps: number): string =>
      authenticator.clone({ epoch: Date.now() + offsetSteps * 30_000 }).generate(secret);
    const wrongFor = (secret: string): string => {
      const valid = new Set([-1, 0, 1].map((o) => at(secret, o)));
      for (let i = 0; ; i += 1) {
        const c = String(i).padStart(6, "0");
        if (!valid.has(c)) return c;
      }
    };

    async function enrolled(username = "asha"): Promise<{ id: string; secret: string }> {
      const { id } = await createUser(db, { username, fullName: "A", password: PASSWORD });
      const r = await enrollTotp(db, cfg, id, { password: PASSWORD });
      if (!r.ok) throw new Error(`enrol refused: ${r.reason}`);
      expect((await confirmTotp(db, cfg, id, at(r.secret, 0))).ok).toBe(true);
      return { id, secret: r.secret };
    }

    it("R1 — first enrolment needs the password: none, or a wrong one, is refused and writes nothing", async () => {
      const { id } = await createUser(db, { username: "asha", fullName: "A", password: PASSWORD });
      expect(await enrollTotp(db, cfg, id, {})).toEqual({ ok: false, reason: "password_required" });
      expect(await enrollTotp(db, cfg, id, { password: "not-the-password" })).toEqual({ ok: false, reason: "invalid" });
      expect(await db.select().from(userTotp).where(eq(userTotp.userId, id))).toEqual([]);

      const ok = await enrollTotp(db, cfg, id, { password: PASSWORD });
      expect(ok.ok).toBe(true);
    });

    it("R2 — once a factor is ENABLED, re-enrolment needs the CURRENT code; the password alone is refused", async () => {
      const { id, secret } = await enrolled();
      const sealedBefore = (await db.select().from(userTotp).where(eq(userTotp.userId, id)))[0]!.secretSealed;

      expect(await enrollTotp(db, cfg, id, { password: PASSWORD })).toEqual({ ok: false, reason: "current_code_required" });
      expect(await enrollTotp(db, cfg, id, { currentCode: wrongFor(secret) })).toEqual({ ok: false, reason: "invalid" });
      // Nothing moved: the enabled factor is the one that was there.
      const row = (await db.select().from(userTotp).where(eq(userTotp.userId, id)))[0]!;
      expect([row.secretSealed, row.enabledAt === null]).toEqual([sealedBefore, false]);

      const re = await enrollTotp(db, cfg, id, { currentCode: at(secret, 1) });
      expect(re.ok).toBe(true);
      if (!re.ok) return;
      // The NEW secret can be confirmed at once — the replay marker belongs to the old secret.
      expect((await confirmTotp(db, cfg, id, at(re.secret, 1))).ok).toBe(true);
      expect((await verifyTotpCode(db, cfg, id, at(secret, 1))).ok).toBe(false); // the old factor is gone
    });

    it("R3 — a code accepted once is refused the second time, and the next step's code is still accepted", async () => {
      const { id, secret } = await enrolled();
      // `at(secret, 0)` was consumed by the confirm inside `enrolled()`.
      expect(await verifyTotpCode(db, cfg, id, at(secret, 0))).toEqual({ ok: false, reason: "invalid" });
      expect((await verifyTotpCode(db, cfg, id, at(secret, 1))).ok).toBe(true);
      expect(await verifyTotpCode(db, cfg, id, at(secret, 1))).toEqual({ ok: false, reason: "invalid" });
      // An OLDER step than the last accepted one is refused too — codes only move forward.
      expect((await verifyTotpCode(db, cfg, id, at(secret, -1))).ok).toBe(false);
    });

    it("R4 — verification is throttled per user: after five misses even the right code is refused", async () => {
      const { id, secret } = await enrolled();
      for (let i = 0; i < 5; i += 1) {
        expect(await verifyTotpCode(db, cfg, id, wrongFor(secret))).toEqual({ ok: false, reason: "invalid" });
      }
      const refused = await verifyTotpCode(db, cfg, id, at(secret, 1));
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.reason).toBe("throttled");
    });

    it("R5 — confirm and the re-enrol proof share that one counter, so no door is a way round it", async () => {
      const { id, secret } = await enrolled();
      for (let i = 0; i < 3; i += 1) expect((await confirmTotp(db, cfg, id, wrongFor(secret))).ok).toBe(false);
      for (let i = 0; i < 2; i += 1) expect((await enrollTotp(db, cfg, id, { currentCode: wrongFor(secret) })).ok).toBe(false);
      const refused = await verifyTotpCode(db, cfg, id, at(secret, 1));
      expect(!refused.ok && refused.reason).toBe("throttled");
    });
  });
});
