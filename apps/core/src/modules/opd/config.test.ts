import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { opdConfig } from "../../kernel/db/schema";
import { DEFAULT_DANGER_RANGES, DEFAULT_LETTERHEAD, dangerRangesSchema, loadOpdConfig } from "./config";
import type { Db } from "../../kernel/db/client";

describe("opd config", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("hard-fails when the row is missing (no fallbacks)", async () => {
    await expect(loadOpdConfig(db)).rejects.toMatchObject({ code: "opd_not_configured" });
  });

  it("the shipped defaults parse and round-trip: four bands, adult last, weight required under 18", async () => {
    await db.insert(opdConfig).values({ id: "main", followUpExtensionDays: [15, 21, 30], dangerRanges: DEFAULT_DANGER_RANGES, letterhead: DEFAULT_LETTERHEAD, updatedBy: "t" });
    const cfg = await loadOpdConfig(db);
    expect(cfg.slotMinutes).toBe(10);
    expect(cfg.followUpDefaultDays).toBe(7);
    expect(cfg.followUpExtensionDays).toEqual([15, 21, 30]);
    expect(cfg.extensionCapPerDoctorPerMonth).toBe(30);
    expect(cfg.maxSkipsBeforeLeft).toBe(3);
    expect(cfg.perkEveryNth).toBeNull();
    expect(cfg.dangerRanges.bands.map((b) => b.key)).toEqual(["infant", "child_1_5", "child_6_12", "adult"]);
    expect(cfg.dangerRanges.bands[3]!.upToAgeYears).toBeNull();
    expect(cfg.dangerRanges.weightRequiredUnderYears).toBe(18);
    expect(cfg.dangerRanges.bands[3]!.ranges.sbp).toEqual({ min: 90, max: 180 });
    expect(cfg.letterhead).toEqual({ name: "CRK MEDICAL COLLEGE & HOSPITAL", addressLines: ["CHAURASIA CHOWK, HAJIPUR, BIHAR 844101"] });
  });

  it("an invalid danger_ranges JSON hard-fails with opd_config_invalid (a band without an adult tail)", async () => {
    const bad = { weightRequiredUnderYears: 18, bands: [{ key: "adult", upToAgeYears: 13, required: [], ranges: {} }] };
    expect(dangerRangesSchema.safeParse(bad).success).toBe(false);
    await db.insert(opdConfig).values({ id: "main", followUpExtensionDays: [15], dangerRanges: bad, letterhead: DEFAULT_LETTERHEAD, updatedBy: "t" });
    await expect(loadOpdConfig(db)).rejects.toMatchObject({ code: "opd_config_invalid" });
  });
});
