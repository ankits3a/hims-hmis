import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestDb, truncateAll } from "./helpers/db";
import { ensureRole, mkUser } from "./helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { PLANNING_BED_LAYOUT_FILE, planningBedLayoutCsv } from "../scripts/data/gen-ipd-bed-layout";
import { BED_LAYOUT_LOADER_PERMISSION, runBedLayoutLoad } from "../scripts/load-bed-layout";
import type { Db } from "../src/kernel/db/client";

/**
 * E0.3 — the planning workbook is GENERATED, and the loader script is a thin door over `loadBedLayout`.
 * Importing both here is also what type-checks them (`scripts/` is outside the core tsconfig).
 */
describe("ipd bed layout — planning workbook and loader script", () => {
  it("the committed planning CSV is exactly what the generator writes", () => {
    const committed = readFileSync(join(__dirname, "..", "scripts", "data", PLANNING_BED_LAYOUT_FILE), "utf8");
    expect(committed).toBe(planningBedLayoutCsv());
  });

  describe("load-bed-layout --by", () => {
    let db: Db;
    let teardown: () => Promise<void>;
    const FILE = "F01,First floor,F01-MICU,Medical ICU,ward,MED,MICU,F01-MICU-BAY1,Bay 1,F01-MICU-B01,icu,any,none,no,yes,monitor,no,no";
    const HEADER = "floor_code,floor_name,ward_code,ward_name,ward_kind,department,unit_type,room_code,room_name,bed_code,bed_class,gender_rule,isolation,negative_pressure,icu,equipment,daycare,overflow";
    const read = (): string => `${HEADER}\n${FILE}\n`;

    beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
    afterAll(async () => teardown());
    beforeEach(async () => {
      await truncateAll(db);
      const registry = new ModuleRegistry();
      for (const m of ALL_MANIFESTS) registry.install(m);
      await syncPermissions(db, registry);
      await ensureRole(db, "it_admin");
      await grantPermissionToRole(db, registry, "it_admin", BED_LAYOUT_LOADER_PERMISSION);
      await mkUser(db, "it.admin", ["it_admin"]);
      await mkUser(db, "ward.clerk", []);
    });

    it("refuses a person without the permission, and a missing --by", async () => {
      await expect(runBedLayoutLoad(db, ["--file", "x.csv", "--by", "ward.clerk"], read)).rejects.toThrow(/does not hold auth\.users\.manage/);
      await expect(runBedLayoutLoad(db, ["--file", "x.csv"], read)).rejects.toThrow(/--by <username> is required/);
    });

    it("dry-runs by default and writes with --apply, recorded against the named person", async () => {
      const dry = await runBedLayoutLoad(db, ["--file", "x.csv", "--by", "it.admin"], read);
      expect(dry.text).toMatch(/^Bed layout — DRY RUN/);
      expect(dry.report.writes).toBe(0);
      const done = await runBedLayoutLoad(db, ["--file", "x.csv", "--by", "it.admin", "--apply"], read);
      expect(done.report.writes).toBe(4);
    });
  });
});
