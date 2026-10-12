import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { IPD_BED_CLASSES } from "@hmis/contracts";
import { events, resources } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkBedLoader } from "../../../../test/helpers/ipd";
import { BED_LAYOUT_COLUMNS, loadBedLayout, parseBedLayoutCsv } from "../index";
import type { Actor, IpdBedClass } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { BedLayoutColumn } from "../index";

/**
 * ═══ E0.3 — THE WHOLE HOSPITAL INTO THE BED REGISTRY: "DONE MEANS" (issue #715, decision 0072) ═══
 *
 *   (i)   the loader refuses a bed without a class, naming the row, and writes nothing;
 *   (ii)  the planning workbook loads, and the registry then holds exactly the confirmed split per class;
 *   (iii) a second run of the same file writes nothing;
 *   (iv)  airborne isolation without negative pressure is refused.
 *
 * Owner-approved checks are LOCKED once merged: add new ones, never edit these.
 */
const PLANNING_CSV = join(__dirname, "..", "..", "..", "..", "scripts", "data", "ipd-bed-layout.planning.csv");

/**
 * The confirmed split (owner 2026-10-12; breakdown DECIDED in the IPD plan, decision 0072), typed ONCE.
 * `Record<IpdBedClass, number>` makes a class added to the contracts list a compile error here.
 */
const CONFIRMED_SPLIT: Record<IpdBedClass, number> = {
  general: 432, semi_private: 144, private: 108, deluxe: 24, suite: 12,
  icu: 174, hdu: 46, picu: 20, nicu: 50, ldr: 20, daycare: 60, emergency: 60, overflow: 0,
};

const BASE: Record<BedLayoutColumn, string> = {
  floor_code: "F03", floor_name: "Third floor", ward_code: "F03-MED-M", ward_name: "Medicine male", ward_kind: "hall",
  department: "MED", unit_type: "WARD", room_code: "F03-MED-M-BAY1", room_name: "Bay 1", bed_code: "F03-MED-M-B01",
  bed_class: "general", gender_rule: "male", isolation: "none", negative_pressure: "no", icu: "no",
  equipment: "oxygen_point", daycare: "no", overflow: "no",
};

function csv(beds: Partial<Record<BedLayoutColumn, string>>[]): string {
  return [BED_LAYOUT_COLUMNS.join(","), ...beds.map((b) => BED_LAYOUT_COLUMNS.map((c) => ({ ...BASE, ...b })[c]).join(","))].join("\n");
}

describe("E0.3 bed layout loader — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  /** Applying a layout needs `auth.users.manage`; a dry run needs no permission. */
  let ACTOR: Actor;
  beforeEach(async () => { await truncateAll(db); ACTOR = await mkBedLoader(db); });

  const resourceCount = async (): Promise<number> =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(resources))[0]!.n;
  const eventCount = async (): Promise<number> =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(events))[0]!.n;

  it("(i) refuses a bed without a class, naming the row, lists every bad row, and writes nothing", async () => {
    const rows = parseBedLayoutCsv(csv([
      {},
      { bed_code: "F03-MED-M-B02", bed_class: "" }, // row 3
      { bed_code: "F03-MED-M-B03", bed_class: "platinum" }, // row 4
      { bed_code: "F03-MED-M-B01" }, // row 5 — duplicate of row 2
    ]));
    const refused = loadBedLayout(db, ACTOR, rows, { apply: true });
    await expect(refused).rejects.toMatchObject({ code: "bed_layout_invalid" });
    const message = await loadBedLayout(db, ACTOR, rows, { apply: true }).catch((e: Error) => e.message);
    expect(message).toMatch(/row 3: .*bed without a class/);
    expect(message).toMatch(/row 4: unknown class "platinum"/);
    expect(message).toMatch(/row 5: duplicate bed code F03-MED-M-B01 \(first at row 2\)/);
    expect(await resourceCount()).toBe(0);
    expect(await eventCount()).toBe(0);
  });

  it("(ii) the planning workbook loads and the registry holds exactly the confirmed split per class", async () => {
    const rows = parseBedLayoutCsv(readFileSync(PLANNING_CSV, "utf8"));

    const dry = await loadBedLayout(db, ACTOR, rows);
    expect(dry.applied).toBe(false);
    expect(await resourceCount()).toBe(0); // a dry run writes nothing

    const report = await loadBedLayout(db, ACTOR, rows, { apply: true });
    expect(report.update).toEqual([]);
    expect(report.writes).toBe(report.create.length);

    const beds = await db.select({ attributes: resources.attributes, status: resources.status })
      .from(resources).where(eq(resources.kind, "bed"));
    const held = Object.fromEntries(IPD_BED_CLASSES.map((c) => [c, beds.filter((b) => b.attributes.class === c).length]));
    for (const cls of IPD_BED_CLASSES) expect({ cls, beds: held[cls] }).toEqual({ cls, beds: CONFIRMED_SPLIT[cls] });
    const total = IPD_BED_CLASSES.reduce((s, c) => s + CONFIRMED_SPLIT[c], 0);
    expect(beds).toHaveLength(total);
    expect(total).toBe(1150); // 720 + 240 + 50 + 20 + 60 + 60, the owner's confirmed beds
    expect(new Set(beds.map((b) => b.status))).toEqual(new Set(["available"]));
    // Every bed sits in the tree: bed → room → ward/hall → floor, and every airborne bed has negative pressure.
    const orphans = await db.execute(sql`
      select b.code from resources b
      left join resources r on r.id = b.parent_id
      left join resources w on w.id = r.parent_id
      left join resources f on f.id = w.parent_id
      where b.kind = 'bed' and (r.kind is distinct from 'room' or w.kind not in ('ward', 'hall') or f.kind is distinct from 'floor')`);
    expect(orphans.rows).toEqual([]);
    expect(beds.filter((b) => b.attributes.isolation === "airborne" && b.attributes.negativePressure !== true)).toEqual([]);
  }, 300_000);

  it("(iii) a second run of the same file writes nothing", async () => {
    const rows = parseBedLayoutCsv(readFileSync(PLANNING_CSV, "utf8"));
    await loadBedLayout(db, ACTOR, rows, { apply: true });
    const resourcesBefore = await db.select({ id: resources.id, updatedAt: resources.updatedAt }).from(resources);
    const eventsBefore = await eventCount();

    const again = await loadBedLayout(db, ACTOR, rows, { apply: true });
    expect({ writes: again.writes, create: again.create.length, update: again.update.length, notInFile: again.notInFile })
      .toEqual({ writes: 0, create: 0, update: 0, notInFile: [] });
    expect(again.unchanged).toBe(resourcesBefore.length);
    expect(await eventCount()).toBe(eventsBefore);
    const resourcesAfter = await db.select({ id: resources.id, updatedAt: resources.updatedAt }).from(resources);
    expect(resourcesAfter.sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual(resourcesBefore.sort((a, b) => a.id.localeCompare(b.id)));
  }, 300_000);

  it("(iv) refuses airborne isolation without negative pressure, and writes nothing", async () => {
    const rows = parseBedLayoutCsv(csv([
      {},
      { bed_code: "F03-MED-M-B02", isolation: "airborne", negative_pressure: "no" }, // row 3
      { bed_code: "F03-MED-M-B03", isolation: "airborne", negative_pressure: "yes" }, // row 4 — fine
    ]));
    const message = await loadBedLayout(db, ACTOR, rows, { apply: true }).then(() => "loaded", (e: Error) => e.message);
    expect(message).toMatch(/row 3: airborne isolation needs a negative-pressure room/);
    expect(message).not.toMatch(/row 4/);
    expect(await resourceCount()).toBe(0);
  });
});
