import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { setupRadiologyFixture } from "../../../test/helpers/radiology";
import { seedTariffConfig } from "../../../scripts/seed-tariff";
import { services } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { registerRadiologyApprovalTypes } from "./approval-types";
import { activeDefinitionRow, draftDefinition, requestDefinitionPublish } from "./definitions";
import { setupBooks, setupPrices } from "./setup";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS4 T4's reads — the Setup station's Books and Prices views. Read-only; what is proved
 * is that each shows the fact a person acts on (who approved, what is missing), not a raw id.
 */
describe("the Setup station's reads (18-S RS4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  const DAY = "2026-08-31";
  const NOW = new Date(`${DAY}T06:00:00.000Z`);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
  });
  afterEach(() => { fx.unregister(); });

  describe("prices", () => {
    it("names a RAD- service whose GST category is missing, and shows it once the tariff seed writes it", async () => {
      let rows = await setupPrices(db);
      expect(rows.map((r) => r.code)).toEqual(["RAD-CT-HEAD", "RAD-MRI-BRAIN", "RAD-USG-ABDO", "RAD-XR-CHEST"]);
      expect(rows.every((r) => r.gst === null && r.category === "investigation")).toBe(true);

      await seedTariffConfig(db);
      rows = await setupPrices(db);
      expect(rows[0]!.gst).toEqual({ sacCode: "9993", exempt: true, rateBps: 0 });
      expect(rows[0]!.pricePaise).toBeNull(); // no activated tariff version in this fixture
      expect(rows[0]!.ruledPricePaise).toBeNull(); // a study's price is the owner's list, not ruled
    });

    it("carries ruling 1's price for the ruled services, and leaves non-RAD services out", async () => {
      await db.insert(services).values([
        { id: newId(), code: "RAD-FILM", name: "Imaging film, per sheet", category: "investigation", createdBy: "t", updatedBy: "t" },
        { id: newId(), code: "RAD-2ND-CT-MR", name: "Outside read CT/MR", category: "investigation", createdBy: "t", updatedBy: "t" },
        { id: newId(), code: "LAB-CBC", name: "CBC", category: "investigation", createdBy: "t", updatedBy: "t" },
      ]);
      const rows = await setupPrices(db);
      expect(rows.find((r) => r.code === "RAD-FILM")!.ruledPricePaise).toBe(25_000);
      expect(rows.find((r) => r.code === "RAD-2ND-CT-MR")!.ruledPricePaise).toBe(150_000);
      expect(rows.some((r) => r.code === "LAB-CBC")).toBe(false);
    });
  });

  describe("books", () => {
    it("lists every governed kind, the active study-type book, and a draft waiting on the MS by name", async () => {
      await registerRadiologyApprovalTypes(db, fx.radiologist);
      const active = await withTx(db, (tx) => activeDefinitionRow(tx, "study_types"));
      const { definitionId, approvalId } = await withTx(db, async (tx) => {
        const d = await draftDefinition(tx, fx.radiologist, { kind: "study_types", body: active!.body });
        return { definitionId: d.definitionId, ...(await requestDefinitionPublish(tx, fx.radiologist, d.definitionId)) };
      });

      const books = await setupBooks(db);
      expect(books.map((b) => b.kind)).toEqual([
        "study_types", "pregnancy_policy", "critical_categories", "pacs_settings", "dose_reference_levels",
        "imaging_protocols", // 18-S RS6 — the protocol book the room console reads
      ]);
      const studyTypes = books[0]!;
      expect(studyTypes.active).toMatchObject({ version: active!.version, status: "active" });
      expect(studyTypes.drafts).toEqual([expect.objectContaining({
        definitionId, version: active!.version + 1, status: "draft",
        draftedBy: "dr.rao", approvalId, approvalStatus: "pending", approvedBy: null, seeded: false,
      })]);
      expect(books.find((b) => b.kind === "pacs_settings")).toEqual({ kind: "pacs_settings", active: null, drafts: [] });
    });
  });
});
