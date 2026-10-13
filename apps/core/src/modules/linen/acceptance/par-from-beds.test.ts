import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { SUPA, actorOf, seedLinenHospital } from "../../../../test/helpers/linen";
import { LinenError, setParLevel, topUpWard, wardStates } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { LinenHospital } from "../../../../test/helpers/linen";

/**
 * DONE MEANS (brief E2.4 (i)): "par levels per ward computed from bed count and class". DECIDED: sets per bed — general
 * 3, private/deluxe/suite 4, ICU/HDU/NICU/PICU 5 — times the item's units per set (theatre linen 0); a bed's class is
 * its own, else its ward's, else general; retired beds do not count; a supervisor's par overrides and can be removed.
 */
describe("acceptance — par per ward from its beds and their class", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let h: LinenHospital;
  const now = new Date();

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    h = await seedLinenHospital(db);
  });

  const parOf = async (ward: string, item: string) => {
    const s = (await wardStates(db, now, ward))[0]!;
    return { beds: s.beds, ...s.items.find((i) => i.itemCode === item)! };
  };

  it("10 general beds → 30 of each bed item; the retired bed is not counted; theatre linen is 0", async () => {
    expect(await parOf(h.generalWard, "bedsheet")).toMatchObject({ beds: 10, par: 30, parSource: "computed", onHand: 0, short: 30 });
    expect(await parOf(h.generalWard, "patient_gown")).toMatchObject({ par: 30 });
    expect(await parOf(h.generalWard, "ot_gown")).toMatchObject({ par: 0, short: 0 });
  });

  it("classes mix under one ward (4 private × 4 + 2 ICU × 5 = 26) and a bed without a class takes its ward's (3 × 5 = 15)", async () => {
    const mixed = (await wardStates(db, now, h.mixedWard))[0]!;
    expect(mixed.bedsByClass).toEqual({ private: 4, icu: 2 });
    expect(mixed.items.find((i) => i.itemCode === "towel")?.par).toBe(26);
    expect(await parOf(h.icuWard, "blanket")).toMatchObject({ beds: 3, par: 15 });
  });

  it("a supervisor's par overrides the computed one, and removing it goes back", async () => {
    await setParLevel(db, actorOf(SUPA), { wardId: h.generalWard, itemCode: "bedsheet", par: 40 }, now);
    expect(await parOf(h.generalWard, "bedsheet")).toMatchObject({ par: 40, parSource: "set" });
    await setParLevel(db, actorOf(SUPA), { wardId: h.generalWard, itemCode: "bedsheet", par: null }, now);
    expect(await parOf(h.generalWard, "bedsheet")).toMatchObject({ par: 30, parSource: "computed" });
  });

  it("top-up fills exactly to par, then the ward is at par", async () => {
    const r = await topUpWard(db, actorOf(SUPA), { wardId: h.mixedWard }, now);
    expect(r.movements).toBe(6); // the six bed-set items; theatre linen has par 0
    const s = (await wardStates(db, now, h.mixedWard))[0]!;
    expect(s.items.filter((i) => i.par > 0).every((i) => i.onHand === 26 && i.short === 0)).toBe(true);
    expect(s.belowPar).toBe(false);
    await expect(topUpWard(db, actorOf(SUPA), { wardId: h.mixedWard }, now)).rejects.toMatchObject({ code: "at_par" });
    await expect(topUpWard(db, actorOf(SUPA), { wardId: h.mixedWard, lines: [{ itemCode: "bedsheet", qty: 1 }] }, now))
      .rejects.toBeInstanceOf(LinenError);
  });
});
