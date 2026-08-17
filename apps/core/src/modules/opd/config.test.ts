import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { opdConfig } from "../../kernel/db/schema";
import { DEFAULT_DANGER_RANGES, DEFAULT_LETTERHEAD, dangerRangesSchema, loadOpdConfig, updateOpdConfig } from "./config";
import type { DangerRangesConfig } from "./config";
import type { Actor } from "@hmis/contracts";
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

  it("updateOpdConfig patches one field; an invalid danger_ranges is refused and the stored row is unchanged", async () => {
    await db.insert(opdConfig).values({ id: "main", followUpExtensionDays: [15, 21, 30], dangerRanges: DEFAULT_DANGER_RANGES, letterhead: DEFAULT_LETTERHEAD, updatedBy: "t" });
    const actor: Actor = { type: "user", id: "u-admin" };

    const patched = await withTx(db, (tx) => updateOpdConfig(tx, actor, { slotMinutes: 15 }));
    expect(patched.slotMinutes).toBe(15);

    const bad = { weightRequiredUnderYears: 18, bands: [{ key: "adult", upToAgeYears: 13, required: [], ranges: {} }] } as unknown as DangerRangesConfig;
    await expect(withTx(db, (tx) => updateOpdConfig(tx, actor, { dangerRanges: bad }))).rejects.toMatchObject({ code: "invalid_config" });

    const after = await loadOpdConfig(db);
    expect(after.slotMinutes).toBe(15);
    expect(after.dangerRanges.bands.map((b) => b.key)).toEqual(["infant", "child_1_5", "child_6_12", "adult"]);
  });
});
