import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { gstSettings } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { getGstSettings, listGstCategories, upsertGstCategory, upsertGstSettings } from "./gst-config";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const actor: Actor = { type: "user", id: "u1" };

describe("GST config (D-3): gst-config.ts", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => truncateAll(db));

  test("category upsert + list round-trip (threshold paise as a number)", async () => {
    await withTx(db, (tx) =>
      upsertGstCategory(tx, actor, {
        category: "room_rent",
        sacCode: "999311",
        exempt: false,
        rateBps: 500,
        specialRule: "room_rent_daily_threshold",
        thresholdPaise: 500000,
      }),
    );

    const rows = await listGstCategories(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      category: "room_rent",
      sacCode: "999311",
      exempt: false,
      rateBps: 500,
      specialRule: "room_rent_daily_threshold",
      thresholdPaise: 500000,
    });
    expect(typeof rows[0]?.thresholdPaise).toBe("number");
  });

  test("gst_config_invalid on room-rent rule without threshold, and on negative rateBps", async () => {
    await expect(
      withTx(db, (tx) =>
        upsertGstCategory(tx, actor, {
          category: "room_rent",
          sacCode: "999311",
          exempt: false,
          rateBps: 500,
          specialRule: "room_rent_daily_threshold",
          thresholdPaise: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "gst_config_invalid" });

    await expect(
      withTx(db, (tx) =>
        upsertGstCategory(tx, actor, {
          category: "pharmacy",
          sacCode: "3004",
          exempt: false,
          rateBps: -100,
          specialRule: null,
          thresholdPaise: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "gst_config_invalid" });
  });

  test("getGstSettings on a missing 'main' row throws settings_missing, naming seed:tariff", async () => {
    await expect(getGstSettings(db)).rejects.toMatchObject({ code: "settings_missing" });
    await expect(getGstSettings(db)).rejects.toThrow(/seed:tariff/);
  });

  test("settings upsert round-trip: caSigned flip persists, updatedBy recorded", async () => {
    await withTx(db, (tx) => upsertGstSettings(tx, actor, { compositeHealthcareExempt: true, caSigned: false }));
    let settings = await getGstSettings(db);
    expect(settings).toEqual({ compositeHealthcareExempt: true, caSigned: false });

    const signer: Actor = { type: "user", id: "ca-signer" };
    await withTx(db, (tx) => upsertGstSettings(tx, signer, { caSigned: true }));
    settings = await getGstSettings(db);
    expect(settings.caSigned).toBe(true);
    expect(settings.compositeHealthcareExempt).toBe(true); // untouched by the partial patch

    const rows = await db.select().from(gstSettings);
    expect(rows[0]?.updatedBy).toBe("ca-signer");
  });
});
