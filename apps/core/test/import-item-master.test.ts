import { setupTestDb, truncateAll } from "./helpers/db";
import { seedPharmacyBase } from "./helpers/pharmacy";
import { applyItemMaster, parseItemMaster, planItemMaster } from "../scripts/import-item-master";
import { getItem, listItems, registerItem } from "../src/modules/materials";
import { listMedicines } from "../src/modules/formulary";
import { withTx } from "../src/kernel/db/client";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ THE ITEM MASTER LOADER ═══
 *
 * `pharmacy-go-live.md` §2 is a fortnight of typing, and two of the three fields it asks for cannot
 * be written by any screen. This loader takes the hospital's own file instead.
 *
 * **Its dangerous property is that it runs against production with real data**, so almost every test
 * here is about what it REFUSES rather than what it writes. The one that matters most is the GST
 * column: a loader that helpfully defaulted a blank slab would make the counter bill 12% above the
 * printed MRP on every line it touched.
 */
describe("import:item-master — the hospital's own file, never invented rows", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  const actor = { type: "user" as const, id: "test-importer" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  describe("the file is judged before the database is touched", () => {
    it("refuses a header whose column it does not know, rather than dropping it", () => {
      /* THE FAILURE THIS PREVENTS: a file with `gst_rate` where the loader wants `gst_rate_bps`
         would otherwise import every row with a blank slab and report complete success — the
         operator's entire tax column silently discarded, discovered at a counter weeks later. */
      const parsed = parseItemMaster("code,name,gst_rate\nCROC500,Crocin,1200\n");
      expect(parsed.reasons).toContain("unknown_columns:gst_rate");
    });

    it("refuses a GST value that is not one of the four medicine slabs", () => {
      const parsed = parseItemMaster("code,name,gst_rate_bps\nX1,X,12\n");
      expect(parsed.rows[0]!.reasons).toContain("gst_rate_bps_not_a_slab:12");
    });

    it("refuses a file that contradicts itself rather than picking a winner", () => {
      /* Last-wins would silently apply whichever duplicate happened to sort later. Which of the two
         rows the operator meant is theirs to say, not the loader's to guess. */
      const parsed = parseItemMaster("code,name\nA1,First\nA1,Second\n");
      expect(parsed.rows[1]!.reasons).toContain("duplicate_code_also_on_line:2");
    });

    it("names the line the way a text editor does, so the operator can go straight to it", () => {
      const parsed = parseItemMaster("code,name\nA1,Fine\n,Nameless\n");
      expect(parsed.rows[1]!.line).toBe(3);
      expect(parsed.rows[1]!.reasons).toContain("code_required");
    });

    it("refuses a pack unit with no multiplier, and a multiplier with no unit", () => {
      const a = parseItemMaster("code,name,pack_uom,pack_multiplier\nA1,A,strip,\n");
      expect(a.rows[0]!.reasons).toContain("pack_uom_without_pack_multiplier");
      const b = parseItemMaster("code,name,pack_uom,pack_multiplier\nB1,B,,10\n");
      expect(b.rows[0]!.reasons).toContain("pack_multiplier_without_pack_uom");
    });
  });

  describe("planning against the database", () => {
    it("refuses a medicine brand it cannot resolve, instead of leaving the item unlinked", async () => {
      /* An unlinked drug item is one the pharmacy cannot register for sale, and it looks completely
         normal in the item list. The refusal is what makes that visible at import time. */
      const parsed = parseItemMaster("code,name,base_uom,medicine_brand\nZZ1,Mystery,tablet,No Such Brand\n");
      const plan = await planItemMaster(db, parsed);
      expect(plan.rows[0]!.verdict).toBe("refuse");
      expect(plan.rows[0]!.reasons).toContain("unknown_medicine_brand:No Such Brand");
    });

    it("refuses to create a drug item that names no medicine — DD3, caught at plan time not apply time", async () => {
      /* `registerItem` throws `drug_needs_medicine`: composition, salts and the schedule flag live
         on the formulary medicine and are never copied onto the item. Discovering that at APPLY
         time would mean a raw MaterialsError halfway through a file, which is precisely what
         judging the whole file first is supposed to prevent. This test is why the planner knows. */
      const parsed = parseItemMaster("code,name,base_uom\nORPHAN1,No Medicine,tablet\n");
      const plan = await planItemMaster(db, parsed);
      expect(plan.rows[0]!.verdict).toBe("refuse");
      expect(plan.rows[0]!.reasons).toContain("medicine_brand_required_to_create_a_drug_item");
    });

    it("refuses to change an existing item's base unit, because the ledger already means something by it", async () => {
      const parsed = parseItemMaster("code,name,base_uom\nCROC500,Crocin 500 tablet,strip\n");
      const plan = await planItemMaster(db, parsed);
      expect(plan.rows[0]!.verdict).toBe("refuse");
      expect(plan.rows[0]!.reasons.join()).toMatch(/base_uom_immutable:file=strip db=tablet/);
    });

    it("reports a row that already matches as unchanged, so a re-run is boring", async () => {
      const item = (await listItems(db, { class: "drug" })).find((i) => i.code === "CROC500")!;
      const parsed = parseItemMaster(`code,name,base_uom\nCROC500,${item.name},tablet\n`);
      const plan = await planItemMaster(db, parsed);
      expect(plan.rows[0]!.verdict).toBe("unchanged");
      expect(plan.unchanged).toBe(1);
    });

    it("counts the blank GST slabs, because a blank bills the printed MRP and the operator must know", async () => {
      const parsed = parseItemMaster("code,name,base_uom,gst_rate_bps\nN1,New One,tablet,\nN2,New Two,tablet,1200\n");
      const plan = await planItemMaster(db, parsed);
      expect(plan.blankGst).toBe(1);
      expect(plan.nonZeroGst).toBe(1);
    });
  });

  describe("applying", () => {
    it("creates the item with exactly the file's values, and a blank slab stays NULL", async () => {
      const parsed = parseItemMaster(
        "code,name,base_uom,pack_uom,pack_multiplier,hsn_code,gst_rate_bps,shelf_life_days,medicine_brand\n" +
        "PARA650,Dolo 650 tablet,tablet,strip,15,3004,,1095,Calpol 500\n",
      );
      const plan = await planItemMaster(db, parsed);
      expect(plan.refusals).toBe(0);
      expect(await applyItemMaster(db, actor, parsed, plan)).toEqual({ created: 1, updated: 0 });

      const made = (await listItems(db, { class: "drug" })).find((i) => i.code === "PARA650")!;
      const full = await getItem(db, made.id);
      expect(full).toMatchObject({ name: "Dolo 650 tablet", baseUom: "tablet", hsnCode: "3004", shelfLifeDays: 1095 });
      /* THE ASSERTION THIS WHOLE FILE EXISTS FOR. A blank cell is not zero and not a default: the
         slab stays null, `gstCategoryFor` maps null to pharmacy_exempt, and the patient is billed
         exactly the printed MRP. If this ever reads 1200 the counter is charging above MRP. */
      expect(full!.gstRateBps).toBeNull();
      expect(full!.uoms.find((u) => u.uom === "strip")?.toBaseMultiplier).toBe(15);
    });

    it("writes NOTHING when any single row is refused — the whole file or none of it", async () => {
      /* A half-applied item master is the worst outcome available: the operator cannot tell which
         half landed, and re-running is not obviously safe when the first half already exists. */
      const parsed = parseItemMaster(
        "code,name,base_uom,medicine_brand\nGOOD1,Good One,tablet,Calpol 500\nBAD1,Bad One,,Calpol 500\n",
      );
      const plan = await planItemMaster(db, parsed);
      expect(plan.refusals).toBe(1);
      await expect(applyItemMaster(db, actor, parsed, plan)).rejects.toThrow(/refusing to apply/);
      expect((await listItems(db, { class: "drug" })).some((i) => i.code === "GOOD1")).toBe(false);
    });

    /**
     * THE PROMISE THE FIRST VERSION MADE AND DID NOT KEEP.
     *
     * The header says "the whole file is applied or none of it", and the `refusals` check enforced
     * that for a file already KNOWN to be bad. It did not enforce it for a file that goes bad while
     * being written: `applyItemMaster` opened a transaction PER ROW, so a failure partway left every
     * earlier row committed — the exact half-applied item master the header calls the worst outcome.
     *
     * WHY THIS FIXTURE DISCRIMINATES. A plan is a judgement about a database that can CHANGE between
     * planning and applying, so the failure is induced the way it would really happen: plan two
     * creates, then let somebody else create the second code in the window before applying. Row 1
     * writes, row 2 throws `duplicate_code`. Under the per-row version row 1 survives and this fails;
     * under one transaction the throw rolls it back.
     *
     * Asserting only that apply REJECTS would pass against both versions — it is the state of GOOD1
     * afterwards that tells them apart.
     */
    it("a failure partway through rolls back the rows already written — the whole file or none of it", async () => {
      const csv =
        "code,name,base_uom,medicine_brand\n" +
        "GOOD1,Good One,tablet,Calpol 500\n" +
        "RACE1,Race One,tablet,Calpol 500\n";
      const parsed = parseItemMaster(csv);
      const plan = await planItemMaster(db, parsed);
      expect(plan.creates).toBe(2);
      expect(plan.refusals).toBe(0);

      /* somebody else takes RACE1 between the plan and the apply */
      const medicineId = (await listMedicines(db)).find((m) => m.brandName === "Calpol 500")!.id;
      await withTx(db, (tx) => registerItem(tx, actor, {
        code: "RACE1", name: "Taken First", class: "drug", baseUom: "tablet",
        batchTracked: true, formularyMedicineId: medicineId,
      }));

      await expect(applyItemMaster(db, actor, parsed, plan)).rejects.toThrow();

      /* GOOD1 must NOT be on the shelf: it was written and then rolled back with the failure. */
      const codes = (await listItems(db, { class: "drug" })).map((i) => i.code);
      expect(codes).not.toContain("GOOD1");
      expect(codes).toContain("RACE1");
    });

    it("updates only the columns the file actually carries, and leaves the rest alone", async () => {
      const before = (await listItems(db, { class: "drug" })).find((i) => i.code === "CROC500")!;
      const parsed = parseItemMaster(`code,name,hsn_code\nCROC500,${before.name},3004\n`);
      const plan = await planItemMaster(db, parsed);
      expect(plan.rows[0]!.changes).toEqual(["hsnCode"]);
      await applyItemMaster(db, actor, parsed, plan);

      const after = (await listItems(db, { class: "drug" })).find((i) => i.code === "CROC500")!;
      expect(after.hsnCode).toBe("3004");
      /* The fixture's CROC500 carries gstRateBps 1200. The file said nothing about the slab, so the
         loader must not touch it — "never invents" cuts both ways, and silently blanking a
         hospital's configured tax rate would be the same defect facing the other direction. */
      expect(after.gstRateBps).toBe(before.gstRateBps);
      expect(after.baseUom).toBe(before.baseUom);
    });

    it("is idempotent: the second run of the same file is entirely unchanged", async () => {
      const csv = "code,name,base_uom,hsn_code,gst_rate_bps,medicine_brand\nIDEM1,Idempotent 500 tablet,tablet,3004,500,Calpol 500\n";
      const first = parseItemMaster(csv);
      await applyItemMaster(db, actor, first, await planItemMaster(db, first));

      const second = parseItemMaster(csv);
      const plan = await planItemMaster(db, second);
      expect(plan.rows[0]!.verdict).toBe("unchanged");
      expect(await applyItemMaster(db, actor, second, plan)).toEqual({ created: 0, updated: 0 });
      expect((await listItems(db, { class: "drug" })).filter((i) => i.code === "IDEM1")).toHaveLength(1);
    });
  });
});
