import { eq } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { resources } from "../../kernel/db/schema";
import { KERNEL_RESOURCE_KINDS, assignResource, createResource } from "../../kernel/resources";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkBedLoader } from "../../../test/helpers/ipd";
import { BED_LAYOUT_COLUMNS, formatBedLayoutReport, loadBedLayout, parseBedLayoutCsv, validateBedLayout } from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { BedLayoutColumn } from "./index";

const NOBODY: Actor = { type: "user", id: "U-NO-GRANTS" };

const BASE: Record<BedLayoutColumn, string> = {
  floor_code: "F01", floor_name: "First floor", ward_code: "F01-MICU", ward_name: "Medical ICU", ward_kind: "ward",
  department: "MED", unit_type: "MICU", room_code: "F01-MICU-BAY1", room_name: "Bay 1", bed_code: "F01-MICU-B01",
  bed_class: "icu", gender_rule: "any", isolation: "none", negative_pressure: "no", icu: "yes",
  equipment: "monitor;oxygen_point", daycare: "no", overflow: "no",
};

function csv(beds: Partial<Record<BedLayoutColumn, string>>[]): string {
  return [BED_LAYOUT_COLUMNS.join(","), ...beds.map((b) => BED_LAYOUT_COLUMNS.map((c) => ({ ...BASE, ...b })[c]).join(","))].join("\n");
}

describe("parseBedLayoutCsv and validateBedLayout (pure)", () => {
  it("numbers rows as a spreadsheet does (header = row 1, blank lines counted)", () => {
    const rows = parseBedLayoutCsv(`${csv([{}])}\n\n${csv([{ bed_code: "X" }]).split("\n")[1]!}`);
    expect(rows.map((r) => r.row)).toEqual([2, 4]);
  });

  it("refuses a header with a missing or misspelt column", () => {
    expect(() => parseBedLayoutCsv("floor_code,bed_clas\nF01,icu")).toThrow(/missing .*bed_class.*unknown bed_clas/);
  });

  it("refuses the same ward described two ways, and a ward that is a hall on another row", () => {
    const { problems } = validateBedLayout(parseBedLayoutCsv(csv([
      {}, { bed_code: "F01-MICU-B02", unit_type: "SICU" }, { bed_code: "F01-MICU-B03", ward_kind: "hall" },
    ])));
    expect(problems.map((p) => [p.row, p.code])).toEqual([[3, "inconsistent_ward"], [4, "inconsistent_ward"]]);
  });

  it("refuses an overflow mismatch and a flag that is not yes or no", () => {
    const { problems } = validateBedLayout(parseBedLayoutCsv(csv([
      { bed_class: "overflow", icu: "no" }, { bed_code: "F01-MICU-B02", icu: "maybe" },
    ])));
    expect(problems.map((p) => [p.row, p.code])).toEqual([[2, "overflow_mismatch"], [3, "bad_flag"]]);
  });
});

describe("parseBedLayoutCsv refuses a malformed file", () => {
  it("refuses a header that names a column twice", () => {
    expect(() => parseBedLayoutCsv(`${BED_LAYOUT_COLUMNS.join(",")},bed_code\n`)).toThrow(/duplicate column bed_code/);
  });

  it("refuses a data row whose cell count differs from the header's, naming the row", () => {
    const good = csv([{}]).split("\n")[1]!;
    const text = `${BED_LAYOUT_COLUMNS.join(",")}\n${good}\n${good},extra\n${good.split(",").slice(0, -2).join(",")}`;
    expect(() => parseBedLayoutCsv(text)).toThrow(/row 3: 19 cells, the header has 18[\s\S]*row 4: 16 cells, the header has 18/);
  });
});

describe("loadBedLayout against the registry", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  let ACTOR: Actor;
  beforeEach(async () => { await truncateAll(db); ACTOR = await mkBedLoader(db); });

  async function bed(code: string) {
    return (await db.select().from(resources).where(eq(resources.code, code)))[0]!;
  }

  it("creates floor → ward → room → bed with the attributes; a bed without a room hangs on its ward", async () => {
    const report = await loadBedLayout(db, ACTOR, parseBedLayoutCsv(csv([{}, { bed_code: "F01-MICU-B02", room_code: "", room_name: "" }])), { apply: true });
    expect(report.create.map((c) => c.kind)).toEqual(["floor", "ward", "room", "bed", "bed"]);
    const b1 = await bed("F01-MICU-B01");
    expect(b1.attributes).toEqual({
      class: "icu", genderRule: "any", isolation: "none", negativePressure: false, icu: true,
      equipment: ["monitor", "oxygen_point"], daycare: false, overflow: false,
    });
    const ward = (await db.select().from(resources).where(eq(resources.kind, "ward")))[0]!;
    expect(ward.attributes).toEqual({ department: "MED", unitType: "MICU", wardType: "ward" });
    expect((await bed("F01-MICU-B02")).parentId).toBe(ward.id);
  });

  it("updates a changed attribute and keeps attributes it does not own; reports beds not in the file and leaves them", async () => {
    await loadBedLayout(db, ACTOR, parseBedLayoutCsv(csv([{}, { bed_code: "F01-MICU-B02" }])), { apply: true });
    const b1 = await bed("F01-MICU-B01");
    await db.update(resources).set({ attributes: { ...b1.attributes, assetTag: "A-17" } }).where(eq(resources.id, b1.id));

    const report = await loadBedLayout(db, ACTOR, parseBedLayoutCsv(csv([{ equipment: "suction;monitor" }])), { apply: true });
    expect(report.update).toEqual([{ kind: "bed", code: "F01-MICU-B01", row: 2, fields: ["attributes.equipment"] }]);
    expect(report.notInFile).toEqual(["F01-MICU-B02"]);
    expect(report.writes).toBe(1);
    expect((await bed("F01-MICU-B01")).attributes).toMatchObject({ equipment: ["monitor", "suction"], assetTag: "A-17" });
    expect((await bed("F01-MICU-B02")).status).toBe("available"); // left alone: never retired by a file
    expect(formatBedLayoutReport(report)).toMatch(/not in file \(left alone\): 1\n {4}F01-MICU-B02/);
  });

  it("refuses a code that is already a place elsewhere (an OT recovery bay), and writes nothing", async () => {
    await withTx(db, (tx) => createResource(tx, ACTOR, KERNEL_RESOURCE_KINDS, { kind: "bed", code: "F01-MICU-B01", name: "Recovery bay 1" }));
    const before = await db.select().from(resources);
    await expect(loadBedLayout(db, ACTOR, parseBedLayoutCsv(csv([{}])), { apply: true }))
      .rejects.toThrow(/row 2: bed F01-MICU-B01 already exists at the top of the registry, not where this file puts it/);
    expect(await db.select().from(resources)).toEqual(before);
  });

  it("a dry run reports the same diff and writes nothing", async () => {
    const report = await loadBedLayout(db, ACTOR, parseBedLayoutCsv(csv([{}])));
    expect({ applied: report.applied, creates: report.create.length, writes: report.writes }).toEqual({ applied: false, creates: 4, writes: 0 });
    expect(await db.select().from(resources)).toEqual([]);
  });

  it("refuses --apply by a person without auth.users.manage, and writes nothing; a dry run needs no permission", async () => {
    const rows = parseBedLayoutCsv(csv([{}]));
    await expect(loadBedLayout(db, NOBODY, rows, { apply: true })).rejects.toMatchObject({ code: "bed_layout_forbidden" });
    expect(await db.select().from(resources)).toEqual([]);
    expect((await loadBedLayout(db, NOBODY, rows)).create).toHaveLength(4);
  });

  it("refuses a clinical attribute change on an occupied bed; an equipment-only change passes", async () => {
    await loadBedLayout(db, ACTOR, parseBedLayoutCsv(csv([{}])), { apply: true });
    const b1 = await bed("F01-MICU-B01");
    await withTx(db, (tx) => assignResource(tx, ACTOR, KERNEL_RESOURCE_KINDS, b1.id, { occupantType: "admission", occupantRef: "ADM-1" }));

    for (const change of [
      { bed_class: "hdu", icu: "no" }, { gender_rule: "male" }, { isolation: "contact" }, { icu: "no" },
    ] as Partial<Record<BedLayoutColumn, string>>[]) {
      await expect(loadBedLayout(db, ACTOR, parseBedLayoutCsv(csv([change])), { apply: true }))
        .rejects.toThrow(/row 2: bed F01-MICU-B01 is occupied; change its attributes after discharge/);
    }
    expect((await bed("F01-MICU-B01")).attributes).toEqual(b1.attributes);

    const ok = await loadBedLayout(db, ACTOR, parseBedLayoutCsv(csv([{ equipment: "monitor;suction" }])), { apply: true });
    expect(ok.update.map((u) => u.fields)).toEqual([["attributes.equipment"]]);
  });

  it("refuses a ward whose code is already a hall in the registry (and the reverse), case-insensitively", async () => {
    await loadBedLayout(db, ACTOR, parseBedLayoutCsv(csv([{}])), { apply: true });
    const before = await db.select().from(resources);
    await expect(loadBedLayout(db, ACTOR, parseBedLayoutCsv(csv([{ ward_code: "f01-micu", ward_kind: "hall", bed_code: "F01-MICU-B09", room_code: "", room_name: "" }])), { apply: true }))
      .rejects.toThrow(/row 2: hall f01-micu — the registry already has a ward with that code/);
    expect(await db.select().from(resources)).toEqual(before);
  });
});
