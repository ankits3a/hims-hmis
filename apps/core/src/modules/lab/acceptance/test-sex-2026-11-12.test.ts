import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { seedLabDeskBase, serviceIdForLabCode } from "../../../../test/helpers/lab";
import { withTx } from "../../../kernel/db/client";
import { labAnalytes, patients } from "../../../kernel/db/schema";
import { QuickEntryError, saveQuickResults, startQuick } from "../quick";
import { sexSpecificTests } from "../test-sex";
import type { LabDeskFixture } from "../../../../test/helpers/lab";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — owner 2026-11-12: "why is the pregnancy related test allowed in male gender?" A test for one sex
 * (every parameter carries the same `applies_to_sex`) is refused for a patient recorded as the other sex, on the
 * quick bench, and is listed for the pickers to hide. `other` and `unknown` are not refused. A lab ORDER is not
 * refused: the full bench already stops such a result at entry, where a second person may vouch (17d T1).
 */
describe("owner 2026-11-12 — tests for one sex", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  const NOW = new Date("2026-08-29T06:00:00Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
  });
  afterEach(() => { fx.unregister(); });

  const setSex = (sex: string) => db.update(patients).set({ administrativeGender: sex }).where(eq(patients.id, fx.patientId));
  const quick = (codes: string[]) => withTx(db, (tx) => startQuick(tx, fx.desk.actor, {
    patientId: fx.patientId, encounterNo: null, serviceIds: codes.map(serviceIdForLabCode), bloodCollected: true,
  }, NOW));

  it("lists UPT as female-only and PSA as male-only; a panel for both sexes is not listed", async () => {
    const list = await sexSpecificTests(db);
    expect(list.find((t) => t.code === "UPT")?.forSex).toBe("female");
    expect(list.find((t) => t.code === "PSA")?.forSex).toBe("male");
    expect(list.find((t) => t.code === "CBC")).toBeUndefined();
  });

  it("the quick bench refuses UPT for a male patient and starts it for a female or unknown one", async () => {
    await setSex("male");
    const refused = await quick(["UPT"]).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(QuickEntryError);
    expect((refused as QuickEntryError).code).toBe("test_not_applicable");
    expect((refused as QuickEntryError).message).toContain("UPT is only for female patients");
    await setSex("female");
    await expect(quick(["UPT"])).resolves.toBeDefined();
    await setSex("unknown");
    await expect(quick(["UPT"])).resolves.toBeDefined();
  });

  it("the quick bench refuses a female-only parameter added by hand for a male patient", async () => {
    await setSex("male");
    const row = await quick(["CBC"]);
    const [upt] = await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, "UPT"));
    const refused = await withTx(db, (tx) => saveQuickResults(tx, fx.desk.actor, {
      id: row.id, summary: "", lines: [{ analyteId: upt!.id, value: "Positive" }],
    }, NOW)).catch((e: unknown) => e);
    expect((refused as QuickEntryError).code).toBe("test_not_applicable");
  });
});
