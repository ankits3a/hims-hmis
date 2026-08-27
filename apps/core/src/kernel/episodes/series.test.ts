import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { episodeSeries } from "../db/schema";
import { withTx } from "../db/client";
import { EPISODE_MAX_SERIAL, EPISODE_SERIES, formatEpisodeNo, nextEpisodeNo } from "./series";
import type { Db } from "../db/client";

const DAY = "2026-08-25";

describe("formatEpisodeNo (pure)", () => {
  it("renders <letter><YYMMDD><4-digit serial> for every reserved document type", () => {
    expect(formatEpisodeNo("visit", DAY, 147)).toBe("V2608250147");
    expect(formatEpisodeNo("appointment", DAY, 42)).toBe("A2608250042");
    expect(formatEpisodeNo("lab_order", DAY, 23)).toBe("L2608250023");
    expect(formatEpisodeNo("lab_specimen", DAY, 5)).toBe("S2608250005");
    expect(formatEpisodeNo("radiology_order", DAY, 8)).toBe("R2608250008");
    expect(formatEpisodeNo("pharmacy_dispense", DAY, 311)).toBe("P2608250311");
    // PLAN 14 T1 — the one MULTI-letter prefix, and it renders in exactly the same format: the
    // serial is still padded to four digits and the date slice is still YYMMDD. `series.ts` says
    // why a stores document does not take a single letter.
    expect(formatEpisodeNo("grn", DAY, 7)).toBe("GRN2608250007");
  });

  /**
   * PLAN 14 T1 — THE KEY CENSUS, which this file did not carry before and which the plan's T1
   * acceptance names ("`series.test.ts` pins the key list").
   *
   * The three legs below assert three different things and none of them implies another. The
   * CENSUS stops a key being deleted or renamed by a refactor that still compiles — every caller
   * passes a string literal, so a dropped key is a type error at the call site and nowhere else if
   * no call site remains. The DISTINCTNESS leg below already existed and stops two document types
   * sharing a prefix. The PREFIX-FREEDOM leg is new and is the one `grn` made necessary: with every
   * prefix a single letter, no prefix could be a prefix of another; with `GRN` in the map, adding a
   * bare `G` later would make `G` + `RN2608` + `250007` parse as a G-series number of a different
   * day, silently, in any reader that slices by position.
   */
  it("the key census is the seven reserved document types, and no more", () => {
    expect(Object.keys(EPISODE_SERIES).sort()).toEqual([
      "appointment", "grn", "lab_order", "lab_specimen", "pharmacy_dispense", "radiology_order",
      "visit",
    ]);
  });

  it("no prefix is a prefix of another — the ambiguity `GRN` introduced the possibility of", () => {
    const prefixes: string[] = Object.values(EPISODE_SERIES);
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a === b) continue;
        expect({ a, b, aStartsWithB: a.startsWith(b) }).toEqual({ a, b, aStartsWithB: false });
      }
    }
  });

  it("the date slice is YYMMDD — the ambiguity the printed label exists to resolve", () => {
    // 25-Aug-2026 renders 260825, which a desk reading DD-MM-YY would take for 26-Aug-2025.
    // That is why every artifact prints the human date beside the number; the number itself is
    // YYMMDD so that lexicographic order is chronological order.
    expect(formatEpisodeNo("visit", "2026-08-25", 1)).toBe("V2608250001");
    expect(formatEpisodeNo("visit", "2025-08-26", 1)).toBe("V2508260001");
    const sameDayLater = formatEpisodeNo("visit", "2026-08-26", 1);
    expect(formatEpisodeNo("visit", "2026-08-25", 9999) < sameDayLater).toBe(true);
  });

  it("every letter is distinct — a shared letter would make two document types collide", () => {
    const letters = Object.values(EPISODE_SERIES);
    expect(new Set(letters).size).toBe(letters.length);
  });

  it("REFUSES a serial the 4-digit daily counter cannot name, rather than over-padding", () => {
    expect(() => formatEpisodeNo("visit", DAY, EPISODE_MAX_SERIAL + 1)).toThrow(/outside 1\.\./);
    expect(() => formatEpisodeNo("visit", DAY, 0)).toThrow(/outside 1\.\./);
    expect(() => formatEpisodeNo("visit", DAY, 1.5)).toThrow(/outside 1\.\./);
    expect(formatEpisodeNo("visit", DAY, EPISODE_MAX_SERIAL)).toBe("V2608259999");
  });

  it("REFUSES anything that is not an IST calendar date", () => {
    expect(() => formatEpisodeNo("visit", "25-08-2026", 1)).toThrow(/YYYY-MM-DD/);
    expect(() => formatEpisodeNo("visit", "2026-08-25T00:00:00Z", 1)).toThrow(/YYYY-MM-DD/);
    expect(() => formatEpisodeNo("visit", "", 1)).toThrow(/YYYY-MM-DD/);
  });
});

describe("nextEpisodeNo (db)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => truncateAll(db));

  it("cold start hands out 0001 and then counts up", async () => {
    expect(await withTx(db, (tx) => nextEpisodeNo(tx, "visit", DAY))).toBe("V2608250001");
    expect(await withTx(db, (tx) => nextEpisodeNo(tx, "visit", DAY))).toBe("V2608250002");
    expect(await withTx(db, (tx) => nextEpisodeNo(tx, "visit", DAY))).toBe("V2608250003");
  });

  it("each document type counts independently on the same day", async () => {
    await withTx(db, (tx) => nextEpisodeNo(tx, "visit", DAY));
    await withTx(db, (tx) => nextEpisodeNo(tx, "visit", DAY));
    // Lab does not inherit the visit counter — it starts its own day at 1.
    expect(await withTx(db, (tx) => nextEpisodeNo(tx, "lab_order", DAY))).toBe("L2608250001");
    expect(await withTx(db, (tx) => nextEpisodeNo(tx, "visit", DAY))).toBe("V2608250003");
  });

  it("each day counts independently, and yesterday's counter is untouched by today's", async () => {
    await withTx(db, (tx) => nextEpisodeNo(tx, "visit", "2026-08-25"));
    await withTx(db, (tx) => nextEpisodeNo(tx, "visit", "2026-08-25"));
    expect(await withTx(db, (tx) => nextEpisodeNo(tx, "visit", "2026-08-26"))).toBe("V2608260001");
    expect(await withTx(db, (tx) => nextEpisodeNo(tx, "visit", "2026-08-25"))).toBe("V2608250003");
  });

  it("20 concurrent allocations produce 20 distinct numbers — the single-winner UPDATE", async () => {
    const batch = await Promise.all(
      Array.from({ length: 20 }, () => withTx(db, (tx) => nextEpisodeNo(tx, "visit", DAY))),
    );
    expect(new Set(batch).size).toBe(20);
    expect(batch.every((n) => /^V26082500\d\d$/.test(n))).toBe(true);
    const row = await db.select().from(episodeSeries).where(eq(episodeSeries.seriesKey, "visit"));
    expect(row[0]!.nextNo).toBe(21); // post-increment: the next number handed out is 21
  });
});
