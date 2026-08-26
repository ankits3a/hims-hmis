import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import {
  PatientError, UHID_MAX_SERIAL, UHID_RESERVED_THROUGH, allocateUhid, formatUhid, isValidUhid, verhoeffCheckDigit,
} from "./uhid";
import type { Db } from "../../kernel/db/client";

/** The current format's body: 7 serial digits. The property tests below all run at that width. */
const BODY = 7;

describe("verhoeffCheckDigit (pure)", () => {
  it("matches the canonical worked example: check digit of 236 is 3", () => {
    expect(verhoeffCheckDigit("236")).toBe(3);
  });

  it("property: appending the check digit always validates", () => {
    for (let i = 0; i < 500; i++) {
      const digits = String(1_000_000 + i * 7919).slice(0, BODY).padStart(BODY, "0");
      const check = verhoeffCheckDigit(digits);
      expect(isValidUhid(`AB${digits}${check}`)).toBe(true);
    }
  });

  it("property: EVERY single-digit substitution is detected", () => {
    const digits = "0123456";
    const check = verhoeffCheckDigit(digits);
    for (let pos = 0; pos < digits.length; pos++) {
      for (let d = 0; d <= 9; d++) {
        if (String(d) === digits[pos]) continue;
        const mutated = digits.slice(0, pos) + String(d) + digits.slice(pos + 1);
        expect(isValidUhid(`AB${mutated}${check}`)).toBe(false);
      }
    }
  });

  it("property: EVERY adjacent transposition is detected (the Luhn 09↔90 gap, closed)", () => {
    const digits = "9081726";
    const check = verhoeffCheckDigit(digits);
    for (let pos = 0; pos < digits.length - 1; pos++) {
      if (digits[pos] === digits[pos + 1]) continue;
      const swapped =
        digits.slice(0, pos) + digits[pos + 1]! + digits[pos]! + digits.slice(pos + 2);
      expect(isValidUhid(`AB${swapped}${check}`)).toBe(false);
    }
  });

  it("formatUhid pads to 7, appends the check digit, and takes a ONE-letter prefix", () => {
    const u = formatUhid("HMS", 123);
    expect(u).toMatch(/^HMS0000123\d$/);
    expect(isValidUhid(u)).toBe(true);
    // Production runs a single letter (owner ruling 2026-08-25) — the prefix is data, not code.
    expect(formatUhid("U", 1_234_501)).toBe("U12345013");
    expect(isValidUhid("U12345013")).toBe(true);
  });

  it("formatUhid REFUSES a serial the 7-digit body cannot hold, rather than over-padding", () => {
    // The silent-corruption case: String(10_000_000).padStart(7,"0") is EIGHT digits, which would
    // mint a UHID that isValidUhid rejects for the rest of that patient's life.
    expect(() => formatUhid("U", UHID_MAX_SERIAL + 1)).toThrow(/outside 1\.\./);
    expect(() => formatUhid("U", 0)).toThrow(/outside 1\.\./);
    expect(() => formatUhid("U", 1.5)).toThrow(/outside 1\.\./);
    expect(isValidUhid(formatUhid("U", UHID_MAX_SERIAL))).toBe(true); // the last issuable serial
  });

  it("isValidUhid rejects malformed shapes, the RETIRED format, and a wrong check digit", () => {
    expect(isValidUhid("HMS00001234")).toBe(false); // 8 body digits, no check digit
    expect(isValidUhid("HMS012345678")).toBe(false); // 9 digits — one too many
    expect(isValidUhid("hms0012345")).toBe(false); // lowercase prefix is not the stored form
    expect(isValidUhid("TOOLONGX0012345")).toBe(false); // 8-letter prefix
    expect(isValidUhid("0012345")).toBe(false); // no prefix at all
    // The pre-2026-08-25 format, which the re-mint script relies on being rejected to find rows.
    expect(isValidUhid("CRK-00000001-7")).toBe(false);
    const good = formatUhid("HMS", 123);
    const badCheck = good.slice(0, -1) + String((Number(good.slice(-1)) + 1) % 10);
    expect(isValidUhid(badCheck)).toBe(false);
  });
});

describe("allocateUhid (db)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => truncateAll(db));

  it("hard-fails when registration_config is missing (no fallbacks)", async () => {
    await expect(withTx(db, (tx) => allocateUhid(tx))).rejects.toMatchObject({
      code: "registration_not_configured",
    });
  });

  it("allocates valid, unique, increasing UHIDs — including 20 concurrent allocations", async () => {
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    const one = await withTx(db, (tx) => allocateUhid(tx));
    expect(one.startsWith("HMS")).toBe(true);
    expect(isValidUhid(one)).toBe(true);

    const batch = await Promise.all(
      Array.from({ length: 20 }, () => withTx(db, (tx) => allocateUhid(tx))),
    );
    expect(new Set(batch).size).toBe(20);
    for (const u of batch) expect(isValidUhid(u)).toBe(true);
  });

  it("never issues out of the reserved band — migration 0024 put the counter above the floor", async () => {
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    const u = await withTx(db, (tx) => allocateUhid(tx));
    const serial = Number(u.slice(3, 3 + BODY)); // strip "HMS", drop the trailing check digit
    expect(serial).toBeGreaterThan(UHID_RESERVED_THROUGH);
  });

  it("REFUSES to mint when the counter has been reset below the floor", async () => {
    // The failure this guards: a restore, a hand-rolled dev reset or a stray RESTART puts the
    // sequence back at 1, and registration silently begins issuing reserved numbers. `startWith`
    // on the sequence object does not prevent it — only this check does.
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    await db.execute(sql`select setval('uhid_seq', 100, false)`);
    try {
      await expect(withTx(db, (tx) => allocateUhid(tx))).rejects.toThrow(/reserved band/);
    } finally {
      await db.execute(sql`select setval('uhid_seq', ${UHID_RESERVED_THROUGH + 1}, false)`);
    }
    // …and the very next allocation, once the counter is fixed, is the first issuable serial.
    expect(await withTx(db, (tx) => allocateUhid(tx))).toBe(formatUhid("HMS", UHID_RESERVED_THROUGH + 1));
  });

  it("PatientError carries its code", () => {
    const e = new PatientError("registration_not_configured");
    expect(e.code).toBe("registration_not_configured");
    expect(e.name).toBe("PatientError");
  });
});
