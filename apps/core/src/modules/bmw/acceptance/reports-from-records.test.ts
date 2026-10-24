import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { SUP1, W1, actorOf, bagInStore, seedBmwHospital } from "../../../../test/helpers/bmw";
import { bmwBags } from "../../../kernel/db/schema";
import { formIvCsv, formIvReport, generateBag, handOverManifest, monthlyReport, monthlyReportCsv, recordCbwtfWeight } from "../index";
import type { BmwReportLine } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * DONE MEANS (spec §11): "Monthly BMW report and annual Form IV figures come from the bag records with no typing."
 * The bags are made by the intents at explicit instants (the reports read no clock but the `now` handed to Form IV);
 * the expected figures are computed HERE, independently, from the raw bag rows — and the report must equal them.
 * The IST month edge is in the data: 23:50 IST on 31 March is March, 00:10 IST on 1 April is April.
 */
const IST = (s: string): Date => new Date(`${s}+05:30`);
const istMonth = (d: Date | null): string | null => (d === null ? null : new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 7));
type Line = BmwReportLine["line"];
const linesOf = (category: string, cytotoxic: boolean): Line[] => (category === "yellow" && cytotoxic ? ["yellow", "yellow_cytotoxic"] : [category as Line]);

describe("acceptance — the monthly report and Form IV are read off the bags", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("every figure equals the bag rows; cytotoxic is shown inside yellow, never added twice", async () => {
    const h = await seedBmwHospital(db, IST("2026-03-15T10:00:00"));
    const a = await bagInStore(db, h.roomA, "yellow", 1200, IST("2026-03-02T09:00:00"), 1180, true);
    const b = await bagInStore(db, h.roomA, "yellow", 800, IST("2026-03-02T09:30:00"), 820);
    const c = await bagInStore(db, h.roomB, "red", 500, IST("2026-03-10T14:00:00"));
    const d = await bagInStore(db, h.roomB, "white_translucent", 300, IST("2026-03-31T23:50:00"));
    await bagInStore(db, h.roomA, "blue", 400, IST("2026-04-01T00:10:00"));
    await generateBag(db, actorOf(W1), { category: "red", placeResourceId: h.roomB }, IST("2026-03-20T08:00:00")); // never weighed
    const m1 = await handOverManifest(db, actorOf(SUP1), { barcodes: [a, b, c], cbwtfName: "Bihar Biocare CBWTF", vehicleNo: "BR06GA1234" }, IST("2026-03-03T10:00:00"));
    await recordCbwtfWeight(db, actorOf(SUP1), { manifestId: m1.id, byCategory: [{ category: "yellow", grams: 2010 }], byBag: [{ barcode: c, grams: 505 }] }, IST("2026-03-04T12:00:00"));
    const m2 = await handOverManifest(db, actorOf(SUP1), { barcodes: [d], cbwtfName: "Bihar Biocare CBWTF", vehicleNo: "BR06GA1234" }, IST("2026-04-01T10:00:00"));
    await recordCbwtfWeight(db, actorOf(SUP1), { manifestId: m2.id, byBag: [{ barcode: d, grams: 270 }] }, IST("2026-04-02T10:00:00")); // 10 % light: disputed, still treated

    const bags = await db.select().from(bmwBags);
    const expected = (month: string): Record<Line, Omit<BmwReportLine, "line" | "subsetOf">> => {
      const out = {} as Record<Line, Omit<BmwReportLine, "line" | "subsetOf">>;
      for (const l of ["yellow", "yellow_cytotoxic", "red", "white_translucent", "blue"] as Line[]) {
        out[l] = { generatedBags: 0, generatedGrams: 0, handedOverBags: 0, handedOverGrams: 0, treatedBags: 0, treatedGrams: 0, disputedBags: 0 };
      }
      for (const x of bags) {
        for (const l of linesOf(x.category, x.cytotoxic)) {
          if (istMonth(x.generatedAt) === month) { out[l].generatedBags += 1; out[l].generatedGrams += x.deptWeightGrams ?? 0; }
          if (istMonth(x.handedOverAt) === month) { out[l].handedOverBags += 1; out[l].handedOverGrams += x.centralWeightGrams ?? x.deptWeightGrams ?? 0; }
          if (istMonth(x.treatedAt) === month) { out[l].treatedBags += 1; out[l].treatedGrams += x.cbwtfWeightGrams ?? 0; if (x.state === "disputed") out[l].disputedBags += 1; }
        }
      }
      return out;
    };

    for (const month of ["2026-03", "2026-04"]) {
      const r = await monthlyReport(db, month);
      const want = expected(month);
      for (const { line, subsetOf: _subset, ...figures } of r.lines) expect({ line, ...figures }).toEqual({ line, ...want[line] });
      const counted = r.lines.filter((l) => l.subsetOf === null);
      expect(r.totals.generatedGrams).toBe(counted.reduce((n, l) => n + l.generatedGrams, 0));
    }
    // Spot facts a reader can check by eye.
    const march = await monthlyReport(db, "2026-03");
    expect(march.lines.find((l) => l.line === "yellow")).toMatchObject({ generatedBags: 2, generatedGrams: 2000, treatedGrams: 2010 });
    expect(march.lines.find((l) => l.line === "yellow_cytotoxic")).toMatchObject({ generatedBags: 1, generatedGrams: 1200, subsetOf: "yellow" });
    expect(march.lines.find((l) => l.line === "white_translucent")).toMatchObject({ generatedBags: 1, handedOverBags: 0 });
    expect(march.totals).toMatchObject({ generatedBags: 5, generatedGrams: 2800 });
    expect(march.unweighedBags).toBe(1);
    expect(monthlyReportCsv(march)).toContain("Yellow,2,2.000,2,2.000,2,2.010,0");
    const april = await monthlyReport(db, "2026-04");
    expect(april.lines.find((l) => l.line === "white_translucent")).toMatchObject({ treatedBags: 1, disputedBags: 1 });

    const form = await formIvReport(db, "2026", IST("2027-01-05T12:00:00"));
    for (const m of form.months) {
      const want = expected(m.month);
      for (const line of Object.keys(m.grams) as Line[]) expect(m.grams[line]).toBe(want[line].generatedGrams);
    }
    expect(form.annualTotalGrams).toBe(bags.reduce((n, x) => n + (x.deptWeightGrams ?? 0), 0));
    expect(form.days).toBe(365);
    expect(form.averageGramsPerDay).toBe(Math.round(form.annualTotalGrams / 365));
    expect(formIvCsv(form).split("\n")[0]).toContain("2026-01");
  });
});
