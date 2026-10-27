import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkVendorDesk, seedLinenHospital } from "../../../test/helpers/linen";
import { addLinenVendor, fileLicence, istDayOf, linenSetupView, setLinenItemCost, setUniformRole, setVendorRate, updateLinenVendor } from "./index";
import type { Db } from "../../kernel/db/client";
import type { VendorDesk } from "../../../test/helpers/linen";

/**
 * LD-2 setup (#1014) — the one read the setup screen draws from, and the vendor's turnaround and GST changed after it
 * was added (spec #979: turnaround editable per vendor).
 */
jest.setTimeout(60_000);

describe("LD-2 setup — vendors, rates, item cost, licences, uniform roles", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let d: VendorDesk;
  const now = new Date();

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedLinenHospital(db);
    d = await mkVendorDesk(db);
  });

  it("the setup read carries each vendor with its rates, the items with their cost, the licences and the uniform roles", async () => {
    const v = await addLinenVendor(db, d.desk, { name: "Clean Wash" }, now);
    await setVendorRate(db, d.desk, { linenVendorId: v.id, itemCode: "bedsheet", ratePaise: 1200, effectiveFrom: istDayOf(now) }, now);
    await setLinenItemCost(db, d.desk, { itemCode: "towel", pricePaise: 25_000 });
    await fileLicence(db, d.desk, { kind: "boiler", licenceNo: "IBR/77", authority: "Inspector of Boilers", validFrom: istDayOf(now), validTo: istDayOf(new Date(now.getTime() + 400 * 86_400_000)) }, now);
    await setUniformRole(db, d.desk, { roleKey: "ward_nurse", entitled: true }, now);
    const view = await linenSetupView(db, now);
    expect(view.vendors).toEqual([expect.objectContaining({
      id: v.id, name: "Clean Wash", turnaroundHours: 24, rushTurnaroundHours: 12, gstRateBps: 1800,
      rates: [{ itemCode: "bedsheet", ratePaise: 1200, effectiveFrom: istDayOf(now) }],
    })]);
    expect(view.items.find((i) => i.code === "towel")).toMatchObject({ pricePaise: 25_000, materialsItemId: null });
    expect(view.items.find((i) => i.code === "bedsheet")).toMatchObject({ pricePaise: null });
    expect(view.licences).toEqual([expect.objectContaining({ kind: "boiler", licenceNo: "IBR/77", state: "ok" })]);
    expect(view.uniformRoles).toEqual(["ward_nurse"]);
  });

  it("a vendor's turnaround and GST change later; rush never exceeds routine", async () => {
    const v = await addLinenVendor(db, d.desk, { name: "Clean Wash" }, now);
    const u = await updateLinenVendor(db, d.desk, { linenVendorId: v.id, turnaroundHours: 48, rushTurnaroundHours: 24, gstRateBps: 1200 });
    expect(u).toMatchObject({ turnaroundHours: 48, rushTurnaroundHours: 24, gstRateBps: 1200 });
    await expect(updateLinenVendor(db, d.desk, { linenVendorId: v.id, turnaroundHours: 10 })).rejects.toMatchObject({ code: "bad_input" });
    await expect(updateLinenVendor(db, d.desk, { linenVendorId: "nope", turnaroundHours: 10 })).rejects.toMatchObject({ code: "unknown_vendor" });
  });
});
