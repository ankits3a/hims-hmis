import { randomUUID } from "node:crypto";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkWardSafetyWorld } from "../../../test/helpers/ipd";
import { admissionPlace } from "./admission-place";
import { orderRestraint, readRoundPatient, readWardLots, readWardSafety, readWardStockCatalogue, setWardPar } from "./index";
import type { Db } from "../../kernel/db/client";
import type { WardSafetyWorld } from "../../../test/helpers/ipd";

/**
 * #1007 — the reads the WM-2 entry screens need: the ward's patients on the safety read (to pick whom to record for),
 * the restraints on the round page (the doctor reviews there), and the item / store catalogue the in-charge sets par
 * from without holding the materials read permissions. Explicit IST instants; names are made up.
 */
jest.setTimeout(240_000);

const at = (hhmm: string): Date => new Date(`2026-03-10T${hhmm}:00+05:30`);

describe("ward safety entry reads (#1007)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: WardSafetyWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkWardSafetyWorld(db); });

  it("lists the ward's patients on the safety read and the restraints on the round page", async () => {
    const { admissionId } = await w.admitMed(at("08:00"));
    const wardId = (await admissionPlace(db, admissionId))!.wardId!;
    const s = await readWardSafety(db, w.incharge, { wardId, now: at("09:00") });
    expect(s.patients.map((p) => p.admissionId)).toEqual([admissionId]);
    expect(s.patients[0]!.bedCode).not.toBeNull();

    const o = await orderRestraint(db, w.consultant, { idempotencyKey: randomUUID(), admissionId, kind: "physical", reason: "Agitation" }, { now: at("09:05") });
    const page = await readRoundPatient(db, w.consultant, admissionId, at("09:10"));
    expect(page.restraints?.map((r) => [r.restraintId, r.status])).toEqual([[o.restraintId, "ordered"]]);
  });

  it("gives the in-charge the item and store catalogue for par", async () => {
    const gloves = await w.wardItem("Gloves pair");
    await w.wardItem("Syringe 5 ml");
    const c = await readWardStockCatalogue(db, w.incharge, { search: "glov" });
    expect(c.items.map((i) => i.itemId)).toEqual([gloves.itemId]);
    expect(c.stores.map((s) => s.id)).toContain(w.centralStoreId);
    await expect(readWardStockCatalogue(db, w.nurse, {})).rejects.toMatchObject({ code: "ipd_forbidden" });
  });

  it("lists the lots held at the patient's ward for the bedside stock form, expired ones marked", async () => {
    const { admissionId } = await w.admitMed(at("08:00"));
    const wardId = (await admissionPlace(db, admissionId))!.wardId!;
    const pad = await w.wardItem("Dressing pad");
    const par = await setWardPar(db, w.incharge, { idempotencyKey: randomUUID(), wardId, supplyStoreId: w.centralStoreId, items: [{ itemId: pad.itemId, par: 10 }] }, { now: at("08:30") });
    const good = await w.lot(pad.itemId, par.storeId, 6, "2027-06-30");
    const old = await w.lot(pad.itemId, par.storeId, 2, "2026-02-28");
    const lots = await readWardLots(db, w.nurse, { admissionId, now: at("09:00") });
    expect(lots.lots.map((l) => [l.batchId, l.onHand, l.expired])).toEqual([[old, 2, true], [good, 6, false]]);
    expect(lots.lots[0]).toMatchObject({ itemId: pad.itemId, name: "Dressing pad" });
    await expect(readWardLots(db, w.student, { admissionId })).rejects.toMatchObject({ code: "ipd_forbidden" });
  });
});
