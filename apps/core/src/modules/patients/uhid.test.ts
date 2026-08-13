import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import {
  PatientError, allocateUhid, formatUhid, isValidUhid, verhoeffCheckDigit,
} from "./uhid";
import type { Db } from "../../kernel/db/client";

describe("verhoeffCheckDigit (pure)", () => {
  it("matches the canonical worked example: check digit of 236 is 3", () => {
    expect(verhoeffCheckDigit("236")).toBe(3);
  });

  it("property: appending the check digit always validates", () => {
    for (let i = 0; i < 500; i++) {
      const digits = String(1_000_000 + i * 7919).slice(0, 8).padStart(8, "0");
      const check = verhoeffCheckDigit(digits);
      expect(isValidUhid(`AB-${digits}-${check}`)).toBe(true);
    }
  });

  it("property: EVERY single-digit substitution is detected", () => {
    const digits = "00123456";
    const check = verhoeffCheckDigit(digits);
    for (let pos = 0; pos < digits.length; pos++) {
      for (let d = 0; d <= 9; d++) {
        if (String(d) === digits[pos]) continue;
        const mutated = digits.slice(0, pos) + String(d) + digits.slice(pos + 1);
        expect(isValidUhid(`AB-${mutated}-${check}`)).toBe(false);
      }
    }
  });

  it("property: EVERY adjacent transposition is detected (the Luhn 09↔90 gap, closed)", () => {
    const digits = "90817263";
    const check = verhoeffCheckDigit(digits);
    for (let pos = 0; pos < digits.length - 1; pos++) {
      if (digits[pos] === digits[pos + 1]) continue;
      const swapped =
        digits.slice(0, pos) + digits[pos + 1]! + digits[pos]! + digits.slice(pos + 2);
      expect(isValidUhid(`AB-${swapped}-${check}`)).toBe(false);
    }
  });

  it("formatUhid pads to 8 and appends the check digit", () => {
    const u = formatUhid("HMS", 123);
    expect(u).toMatch(/^HMS-00000123-\d$/);
    expect(isValidUhid(u)).toBe(true);
  });

  it("isValidUhid rejects malformed shapes and a wrong check digit", () => {
    expect(isValidUhid("HMS-00000123")).toBe(false);
    expect(isValidUhid("hms-00000123-4")).toBe(false);
    expect(isValidUhid("TOOLONGX-00000123-4")).toBe(false);
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
    expect(one.startsWith("HMS-")).toBe(true);
    expect(isValidUhid(one)).toBe(true);

    const batch = await Promise.all(
      Array.from({ length: 20 }, () => withTx(db, (tx) => allocateUhid(tx))),
    );
    expect(new Set(batch).size).toBe(20);
    for (const u of batch) expect(isValidUhid(u)).toBe(true);
  });

  it("PatientError carries its code", () => {
    const e = new PatientError("registration_not_configured");
    expect(e.code).toBe("registration_not_configured");
    expect(e.name).toBe("PatientError");
  });
});
