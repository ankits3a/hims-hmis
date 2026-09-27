import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCatalogueCsv } from "../scripts/import-lab-catalogue";
import { KNOWN_ROLE_KEYS } from "../scripts/seed-staff";
import { SYNTHETIC_LAB_DIR, assertNotProduction, readSyntheticInstruments } from "../scripts/seed-lab-synthetic";

/**
 * PLAN 17-F · S — the synthetic laboratory data set (`scripts/synthetic/lab/`), pinned WITHOUT a
 * database. What it guards is the property `tools/lab-synthetic.sh` exists to reach —
 * `standup:check lab` with zero RED on a fresh database — expressed as facts about the files, so a
 * data edit that would turn a census row red fails here before anybody stands a database up.
 *
 * The golden fixture (`test/fixtures/lab-catalogue.json`) and the supplement load into the same
 * database, so every check reads the UNION of the two.
 */

type Fixture = {
  analytes: { code: string }[];
  orderables: { code: string; analyteCodes: string[] }[];
  referenceRanges: { analyteCode: string; source: string }[];
};

const golden = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures", "lab-catalogue.json"), "utf8"),
) as Fixture;
const csv = (name: string): string => readFileSync(resolve(SYNTHETIC_LAB_DIR, name), "utf8");
const analytes = parseCatalogueCsv("analytes", csv("analytes.csv"), "analytes.csv");
const orderables = parseCatalogueCsv("orderables", csv("orderables.csv"), "orderables.csv");
const ranges = parseCatalogueCsv("ranges", csv("ranges.csv"), "ranges.csv");

const allAnalytes = new Set([...golden.analytes.map((a) => a.code), ...analytes.rows.map((r) => r.cells.code!)]);
const allOrderables = [
  ...golden.orderables.map((o) => ({ code: o.code, analyteCodes: o.analyteCodes })),
  ...orderables.rows.map((r) => ({ code: r.cells.code!, analyteCodes: r.cells.analyte_codes!.split(";") })),
];
const bands = [
  ...golden.referenceRanges.map((r) => ({ analyteCode: r.analyteCode, source: r.source })),
  ...ranges.rows.map((r) => ({ analyteCode: r.cells.analyte_code!, source: r.cells.source ?? "" })),
];

describe("the synthetic lab catalogue supplement", () => {
  it("parses with no file- or row-level refusal from the owner's own loader", () => {
    for (const f of [analytes, orderables, ranges]) {
      expect(f.reasons).toEqual([]);
      expect(f.rows.flatMap((r) => r.reasons.map((why) => `${f.fileName}:${String(r.line)} ${why}`))).toEqual([]);
    }
  });

  it("adds codes the golden book does not have — a supplement, never a silent overwrite", () => {
    const goldenOrderables = new Set(golden.orderables.map((o) => o.code));
    const goldenAnalytes = new Set(golden.analytes.map((a) => a.code));
    expect(orderables.rows.map((r) => r.cells.code!).filter((c) => goldenOrderables.has(c))).toEqual([]);
    expect(analytes.rows.map((r) => r.cells.code!).filter((c) => goldenAnalytes.has(c))).toEqual([]);
  });

  it("every orderable names only analytes that exist (census: an order must expand)", () => {
    const missing = allOrderables.flatMap((o) => o.analyteCodes.filter((a) => !allAnalytes.has(a)).map((a) => `${o.code}:${a}`));
    expect(missing).toEqual([]);
  });

  /** `lab_range_sources_present`: every analyte of every orderable has a band, and every band a source. */
  it("every analyte an orderable reports has at least one band with a source", () => {
    const banded = new Set(bands.filter((b) => b.source.trim() !== "").map((b) => b.analyteCode));
    const unbanded = [...new Set(allOrderables.flatMap((o) => o.analyteCodes))].filter((a) => !banded.has(a)).sort();
    expect(unbanded).toEqual([]);
  });

  it("says it is synthetic in every band it adds", () => {
    expect(ranges.rows.filter((r) => !r.cells.source!.startsWith("SYNTHETIC"))).toEqual([]);
  });

  /** `lab_orderables_priced`: the price book covers the golden book and the supplement. */
  it("the synthetic price book prices every orderable, each above zero", () => {
    const prices = new Map(csv("prices.csv").trim().split(/\r?\n/).slice(1).map((l) => {
      const [code, paise] = l.split(",");
      return [code!, Number(paise)] as const;
    }));
    expect(allOrderables.filter((o) => !((prices.get(o.code) ?? 0) > 0)).map((o) => o.code)).toEqual([]);
  });
});

describe("the synthetic staff roster", () => {
  const staff = JSON.parse(csv("staff.json")) as { username: string; roles: string[]; password?: string }[];

  it("carries no credential — passwords are generated at run time and never committed", () => {
    expect(staff.filter((s) => "password" in s || "pin" in s)).toEqual([]);
  });

  it("names only roles seed:staff knows, plus the admin seed:admin creates", () => {
    const known = new Set([...KNOWN_ROLE_KEYS, "admin"]);
    expect(staff.flatMap((s) => s.roles.filter((r) => !known.has(r)))).toEqual([]);
  });

  /** G4 `lab_role_held_*`, the billing manager of ruling 12, and dev-lab-standup's three actors. */
  it("holds every role the lab's census and stand-up need", () => {
    const held = new Set(staff.flatMap((s) => s.roles));
    for (const role of ["lab_reception", "phlebotomist", "lab_technician", "pathologist", "billing_manager",
      "owner", "medical_superintendent"]) {
      expect(held.has(role)).toBe(true);
    }
    const names = staff.map((s) => s.username);
    for (const u of ["dr.meera", "ramesh.front", "supt.rao"]) expect(names).toContain(u);
  });

  it("has two technicians and two pathologists, so the second-person rules can be rehearsed", () => {
    expect(staff.filter((s) => s.roles.includes("lab_technician"))).toHaveLength(2);
    expect(staff.filter((s) => s.roles.includes("pathologist"))).toHaveLength(2);
  });
});

describe("the synthetic analyser inventory", () => {
  const machines = readSyntheticInstruments();

  it("maps only analytes the catalogue defines", () => {
    expect(machines.flatMap((m) => m.analytes.filter((a) => !allAnalytes.has(a)).map((a) => `${m.code}:${a}`))).toEqual([]);
  });

  it("has unique codes and carries the Curio Lab Gen 1 on a run sheet (17-F DECIDED)", () => {
    expect(new Set(machines.map((m) => m.code)).size).toBe(machines.length);
    expect(machines.find((m) => m.code === "CURIO-G1")?.sampleIdMode).toBe("run_sheet");
  });
});

describe("assertNotProduction — the seed's refusals", () => {
  const dev = "postgres://hmis:hmis@localhost:5433/hmis_lab_synth";

  it("refuses without the synthetic-data key", () => {
    expect(() => assertNotProduction("t", { DATABASE_URL: dev })).toThrow(/REFUSED/);
  });

  it("refuses the production port even with the key", () => {
    expect(() => assertNotProduction("t", {
      DATABASE_URL: "postgres://hmis:x@localhost:5434/hmis", HMIS_SYNTHETIC_DATA_OK: "1",
    })).toThrow(/REFUSED/);
  });

  it("refuses with no database named", () => {
    expect(() => assertNotProduction("t", { HMIS_SYNTHETIC_DATA_OK: "1" })).toThrow(/DATABASE_URL/);
  });

  it("allows a dev database with the key — and UAT's production image, whose NODE_ENV is production", () => {
    expect(() => assertNotProduction("t", { DATABASE_URL: dev, HMIS_SYNTHETIC_DATA_OK: "1" })).not.toThrow();
    expect(() => assertNotProduction("t", {
      DATABASE_URL: dev, HMIS_SYNTHETIC_DATA_OK: "1", NODE_ENV: "production",
    })).not.toThrow();
  });
});
